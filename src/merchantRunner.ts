import { createHash } from "node:crypto";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  type PublicClient,
  type Transport,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { addressGroupRegistryAbi } from "./contracts.js";
import { IndexerClient, type MakerPlatformStatsRow } from "./indexer.js";
import type { Logger } from "./logger.js";
import type { MerchantRuntimeSettings } from "./merchantConfig.js";
import {
  buildMerchantAdditions,
  calculateTopChargebackMerchants,
  type MerchantPolicySnapshot,
} from "./merchantPolicy.js";
import { createCuratedGroup, executeMutations, type GroupMutation } from "./onchain.js";
import { CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET } from "./paymentMethods.js";
import { choosePinnedSnapshotBlock } from "./runner.js";

interface StableMerchantSnapshot {
  policy: MerchantPolicySnapshot;
  rowsDigest: Hex;
  indexedThroughBlock: bigint;
}

function digestRows(rows: MakerPlatformStatsRow[]): Hex {
  return `0x${createHash("sha256")
    .update(
      JSON.stringify(
        rows.map((row) => ({
          ...row,
          totalAmountTaken: row.totalAmountTaken.toString(),
          nonManualReleaseVolume: row.nonManualReleaseVolume.toString(),
          manualReleaseVolume: row.manualReleaseVolume.toString(),
        })),
      ),
    )
    .digest("hex")}` as Hex;
}

async function loadStableMerchantSnapshot(indexer: IndexerClient): Promise<StableMerchantSnapshot> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const before = await indexer.getIndexedThroughBlock();
    const firstRows = await indexer.getMakerPlatformStats(CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET);
    const middle = await indexer.getIndexedThroughBlock();
    const secondRows = await indexer.getMakerPlatformStats(CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET);
    const after = await indexer.getIndexedThroughBlock();
    const firstDigest = digestRows(firstRows);
    const secondDigest = digestRows(secondRows);
    if (middle >= before && after >= middle && firstDigest === secondDigest) {
      return {
        policy: calculateTopChargebackMerchants(secondRows),
        rowsDigest: secondDigest,
        indexedThroughBlock: after,
      };
    }
  }
  throw new Error("MakerPlatformStats changed during all stable-snapshot attempts");
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function assertMerchantGroupBounds(
  settings: MerchantRuntimeSettings,
  policy: MerchantPolicySnapshot,
): void {
  if (!settings.group) throw new Error("Merchant group configuration is required");
  if (policy.members.size < settings.group.minimumMembers) {
    throw new Error("Calculated merchant count is below minimumMembers");
  }
  if (policy.members.size > settings.group.maximumMembers) {
    throw new Error("Calculated merchant count exceeds maximumMembers");
  }
}

async function readGovernance<transport extends Transport>(
  publicClient: PublicClient<transport, typeof base>,
  registryAddress: Address,
  groupId: Hex,
  blockNumber?: bigint,
) {
  const [curator, pendingCurator, resolver, isPublic, exists] = await publicClient.readContract({
    address: registryAddress,
    abi: addressGroupRegistryAbi,
    functionName: "getGroup",
    args: [groupId],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  return { curator, pendingCurator, resolver, isPublic, exists };
}

function assertMerchantGovernance(
  governance: Awaited<ReturnType<typeof readGovernance>>,
  signer?: Address,
): void {
  if (!governance.exists) throw new Error("Configured merchant group does not exist");
  if (governance.isPublic) throw new Error("Merchant group permits self-service membership");
  if (governance.pendingCurator !== zeroAddress) {
    throw new Error("Merchant group has a pending curator transfer");
  }
  if (governance.resolver !== zeroAddress) {
    throw new Error("Merchant group has a nonzero resolver");
  }
  if (signer && governance.curator.toLowerCase() !== signer.toLowerCase()) {
    throw new Error("Signer is not the merchant group curator");
  }
}

export async function runMerchant(
  settings: MerchantRuntimeSettings,
  logger: Logger,
): Promise<void> {
  const indexer = new IndexerClient(
    settings.indexerUrl,
    settings.indexerApiKey,
    settings.chainId,
    settings.requestTimeoutMs,
  );
  if (settings.command === "calculate") {
    const snapshot = await loadStableMerchantSnapshot(indexer);
    logger.info(
      {
        indexedThroughBlock: snapshot.indexedThroughBlock.toString(),
        evidenceDigest: snapshot.rowsDigest,
        sourceRows: snapshot.policy.sourceRows,
        memberCount: snapshot.policy.members.size,
        thresholdUsdc: "10000",
        qualifyingVolumeUsdc: (snapshot.policy.qualifyingVolume / 1_000_000n).toString(),
        indexerAccess: settings.indexerApiKey ? "api-key" : "public-rate-limited",
      },
      "Top chargeback merchant snapshot calculated",
    );
    return;
  }

  if (!settings.rpcUrl) throw new Error("RPC_URL is required");
  const publicClient = createPublicClient({
    chain: base,
    transport: http(settings.rpcUrl, { timeout: settings.requestTimeoutMs }),
  });
  if ((await publicClient.getChainId()) !== settings.chainId) {
    throw new Error("RPC chain does not match CHAIN_ID");
  }

  if (settings.command === "create") {
    if (!settings.execute || !settings.allowGroupCreation) {
      throw new Error(
        "Group creation requires EXECUTE=true and ALLOW_MERCHANT_GROUP_CREATION=true",
      );
    }
    if (!settings.registryAddress || !settings.groupAdminPrivateKey) {
      throw new Error("Merchant group creation inputs are unavailable");
    }
    const account = privateKeyToAccount(settings.groupAdminPrivateKey);
    const walletClient = createWalletClient({
      account,
      chain: base,
      transport: http(settings.rpcUrl, { timeout: settings.requestTimeoutMs }),
    });
    const created = await createCuratedGroup({
      publicClient,
      walletClient,
      account,
      registryAddress: settings.registryAddress,
      name: settings.groupName,
    });
    logger.info(
      {
        registryAddress: settings.registryAddress,
        groupId: created.groupId,
        transactionHash: created.transactionHash,
        blockNumber: created.blockNumber.toString(),
      },
      "Top chargeback merchant group created",
    );
    return;
  }

  if (!settings.group) throw new Error("Merchant group configuration is required");
  const [rpcLatestBlock, merchantSnapshot] = await Promise.all([
    publicClient.getBlockNumber(),
    loadStableMerchantSnapshot(indexer),
  ]);
  const snapshotBlock = choosePinnedSnapshotBlock({
    indexedThroughBlock: merchantSnapshot.indexedThroughBlock,
    rpcLatestBlock,
    confirmationBlocks: BigInt(settings.snapshotConfirmations),
  });
  if (settings.group.registryDeploymentBlock > snapshotBlock) {
    throw new Error("Registry deployment block is greater than the selected snapshot");
  }
  assertMerchantGroupBounds(settings, merchantSnapshot.policy);
  const membershipSnapshot = await indexer.getBlockPinnedMembershipSnapshot({
    registryAddress: settings.group.registryAddress,
    groupIds: [settings.group.groupId],
    deploymentBlock: settings.group.registryDeploymentBlock,
    snapshotBlock,
  });
  const current = membershipSnapshot.membership.membersByGroupId.get(settings.group.groupId);
  if (!current) throw new Error("Indexer omitted merchant group membership");
  const governance = await readGovernance(
    publicClient,
    settings.group.registryAddress,
    settings.group.groupId,
    snapshotBlock,
  );
  assertMerchantGovernance(governance);
  const { additions, unexpectedMembers } = buildMerchantAdditions(
    merchantSnapshot.policy.members,
    current,
  );
  if (unexpectedMembers.length > 0) {
    throw new Error("Merchant group contains members outside the calculated one-time cohort");
  }
  if (additions.length > settings.maxPlannedAdds) {
    throw new Error("Merchant additions exceed MAX_PLANNED_ADDS");
  }
  const initialSeed = current.size === 0 && additions.length > 0;
  if (initialSeed && !settings.allowInitialSeed) {
    throw new Error("Initial merchant seed requires ALLOW_INITIAL_SEED=true");
  }
  const groupId = settings.group.groupId;
  const mutations: GroupMutation[] = chunks(additions, settings.batchSize).map((members) => ({
    operation: "add",
    groupId,
    members,
  }));
  logger.info(
    {
      rpcLatestBlock: rpcLatestBlock.toString(),
      snapshotBlock: snapshotBlock.toString(),
      indexedThroughBlock: merchantSnapshot.indexedThroughBlock.toString(),
      evidenceDigest: merchantSnapshot.rowsDigest,
      membershipEvidenceDigest: membershipSnapshot.evidenceDigest,
      sourceRows: merchantSnapshot.policy.sourceRows,
      desiredCount: merchantSnapshot.policy.members.size,
      currentCount: current.size,
      additions: additions.length,
      transactionBatches: mutations.length,
      initialSeed,
      execute: settings.command === "sync" && settings.execute,
    },
    "Top chargeback merchant initialization plan",
  );
  if (settings.command !== "sync" || !settings.execute || mutations.length === 0) return;
  if (!settings.groupAdminPrivateKey) {
    throw new Error("GROUP_ADMIN_PRIVATE_KEY is required for merchant sync execution");
  }
  const account = privateKeyToAccount(settings.groupAdminPrivateKey);
  const currentGovernance = await readGovernance(
    publicClient,
    settings.group.registryAddress,
    settings.group.groupId,
  );
  assertMerchantGovernance(currentGovernance, account.address);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(settings.rpcUrl, { timeout: settings.requestTimeoutMs }),
  });
  const transactionHashes = await executeMutations({
    publicClient,
    walletClient,
    account,
    registryAddress: settings.group.registryAddress,
    mutations,
    onTransaction: (hash, mutation) =>
      logger.info(
        {
          hash,
          groupId: mutation.groupId,
          members: mutation.members.length,
        },
        "Merchant seed transaction mined",
      ),
  });
  logger.info(
    { transactionCount: transactionHashes.length },
    "Top chargeback merchant seed completed",
  );
}
