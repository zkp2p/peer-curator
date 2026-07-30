import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { calculateDesiredSnapshot, calculateDesiredSnapshotFromRows } from "./calculate.js";
import type { RuntimeSettings } from "./config.js";
import { normalizeAddress, tierCounts, tierForAddress } from "./domain.js";
import { type BlockPinnedReconciliationSnapshot, IndexerClient } from "./indexer.js";
import type { Logger } from "./logger.js";
import {
  assertRegistryGovernance,
  executeMutations,
  loadRegistryGovernance,
  loadRegistryState,
} from "./onchain.js";
import { CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET } from "./paymentMethods.js";
import { findCurrentCascadeViolations, mutationsForPhase, selectPhase } from "./phases.js";
import {
  assertDesiredSnapshotBounds,
  assertDesiredSnapshotComplete,
  assertPlanSafe,
  buildReconciliationPlan,
  summarizeRemovalReasons,
} from "./reconcile.js";
import { isBlockedWallet } from "./staticWalletRules.js";

export function assertPinnedIndexerSnapshot(input: {
  snapshotBlock: bigint;
  indexedThroughBlock: bigint;
  rpcLatestBlock: bigint;
  confirmationBlocks: bigint;
}): void {
  if (input.snapshotBlock > input.indexedThroughBlock) {
    throw new Error("Chosen snapshot block is ahead of the indexer watermark");
  }
  if (
    input.rpcLatestBlock < input.confirmationBlocks ||
    input.snapshotBlock > input.rpcLatestBlock - input.confirmationBlocks
  ) {
    throw new Error("Indexer snapshot is not sufficiently confirmed by RPC");
  }
}

export function choosePinnedSnapshotBlock(input: {
  indexedThroughBlock: bigint;
  rpcLatestBlock: bigint;
  confirmationBlocks: bigint;
}): bigint {
  if (input.rpcLatestBlock < input.confirmationBlocks) {
    throw new Error("RPC head is below the required confirmation depth");
  }
  const confirmedRpcBlock = input.rpcLatestBlock - input.confirmationBlocks;
  return input.indexedThroughBlock < confirmedRpcBlock
    ? input.indexedThroughBlock
    : confirmedRpcBlock;
}

export function assertMatchingSnapshotEvidence(
  first: BlockPinnedReconciliationSnapshot,
  second: BlockPinnedReconciliationSnapshot,
): void {
  if (
    first.membership.snapshotBlock !== second.membership.snapshotBlock ||
    first.evidenceDigest !== second.evidenceDigest
  ) {
    throw new Error("Indexer event evidence changed between block-pinned reconstruction passes");
  }
}

export async function run(
  settings: RuntimeSettings,
  logger: Logger,
  verifyAddress?: string,
): Promise<void> {
  const indexer = new IndexerClient(
    settings.indexerUrl,
    settings.indexerApiKey,
    settings.chainId,
    settings.requestTimeoutMs,
  );
  const reconciliationRun = settings.command === "plan" || settings.command === "sync";
  if (reconciliationRun && !settings.groups) {
    throw new Error("Group configuration is required");
  }

  const publicClient =
    reconciliationRun && settings.rpcUrl
      ? createPublicClient({
          chain: base,
          transport: http(settings.rpcUrl, { timeout: settings.requestTimeoutMs }),
        })
      : undefined;
  let rpcLatestBlock: bigint | undefined;
  let indexedThroughBlock: bigint | undefined;
  if (reconciliationRun) {
    if (!publicClient) throw new Error("RPC_URL is required");
    const rpcChainId = await publicClient.getChainId();
    if (rpcChainId !== settings.chainId) {
      throw new Error("RPC chain does not match CHAIN_ID");
    }
    [rpcLatestBlock, indexedThroughBlock] = await Promise.all([
      publicClient.getBlockNumber(),
      indexer.getIndexedThroughBlock(),
    ]);
  }
  const confirmationBlocks = BigInt(settings.snapshotConfirmations);
  const snapshotBlock =
    rpcLatestBlock !== undefined && indexedThroughBlock !== undefined
      ? choosePinnedSnapshotBlock({
          indexedThroughBlock,
          rpcLatestBlock,
          confirmationBlocks,
        })
      : undefined;
  const pinnedSnapshotInput =
    reconciliationRun && settings.groups && snapshotBlock !== undefined
      ? {
          registryAddress: settings.groups.registryAddress,
          groupIds: settings.groups.groups.map((group) => group.groupId),
          deploymentBlock: settings.groups.registryDeploymentBlock,
          paymentMethodHashes: CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET,
          snapshotBlock,
          v2Environment: settings.v2HistoryEnvironment,
        }
      : undefined;
  let pinnedSnapshot = pinnedSnapshotInput
    ? await indexer.getBlockPinnedReconciliationSnapshot(pinnedSnapshotInput)
    : undefined;
  if (pinnedSnapshot) {
    const firstFinalIndexedThroughBlock = await indexer.getIndexedThroughBlock();
    if (
      indexedThroughBlock === undefined ||
      firstFinalIndexedThroughBlock < pinnedSnapshot.membership.snapshotBlock
    ) {
      throw new Error("Indexer watermark fell below the chosen snapshot block");
    }
    if (!pinnedSnapshotInput) {
      throw new Error("Block-pinned snapshot input is unavailable");
    }
    const verifiedSnapshot =
      await indexer.getBlockPinnedReconciliationSnapshot(pinnedSnapshotInput);
    const secondFinalIndexedThroughBlock = await indexer.getIndexedThroughBlock();
    if (secondFinalIndexedThroughBlock < verifiedSnapshot.membership.snapshotBlock) {
      throw new Error("Indexer watermark fell below the chosen snapshot block");
    }
    assertMatchingSnapshotEvidence(pinnedSnapshot, verifiedSnapshot);
    pinnedSnapshot = verifiedSnapshot;
    indexedThroughBlock = secondFinalIndexedThroughBlock;
  }
  const desired = pinnedSnapshot
    ? calculateDesiredSnapshotFromRows(settings, pinnedSnapshot.takerPlatformStats)
    : await calculateDesiredSnapshot(settings, indexer);

  logger.info(
    {
      calculatedAt: desired.calculatedAt,
      indexerAccess: settings.indexerApiKey ? "api-key" : "public-rate-limited",
      blockedWalletCount: desired.blockedWalletCount,
      pinnedMemberCount: settings.pinnedMembers.length,
      policies: [...desired.policies.values()].map((policy) => ({
        scope: policy.scope,
        sourceRows: policy.sourceRows,
        cumulativeCounts: tierCounts(policy),
      })),
    },
    "Desired group membership calculated",
  );

  if (settings.command === "verify") {
    if (!verifyAddress) throw new Error("verify requires a wallet address");
    const address = normalizeAddress(verifyAddress, "verification wallet");
    const historical = desired.policies.get("historical-taker");
    if (!historical) throw new Error("Calculated policy snapshot is incomplete");
    logger.info(
      {
        blocked: isBlockedWallet(address),
        highestTier: tierForAddress(historical, address),
      },
      "Wallet tier verified",
    );
    return;
  }

  if (settings.command === "calculate") return;
  if (!settings.groups) throw new Error("Group configuration is required");
  const groups = settings.groups;
  assertDesiredSnapshotComplete(desired, groups);
  assertDesiredSnapshotBounds(desired, groups);
  if (
    !publicClient ||
    !pinnedSnapshot ||
    rpcLatestBlock === undefined ||
    indexedThroughBlock === undefined
  ) {
    throw new Error("Block-pinned reconciliation inputs are unavailable");
  }
  const membership = pinnedSnapshot.membership;
  assertPinnedIndexerSnapshot({
    snapshotBlock: membership.snapshotBlock,
    indexedThroughBlock,
    rpcLatestBlock,
    confirmationBlocks,
  });
  const onchain = await loadRegistryState(publicClient, groups, membership);
  const account = settings.execute
    ? privateKeyToAccount(settings.groupAdminPrivateKey as `0x${string}`)
    : undefined;
  assertRegistryGovernance({
    config: groups,
    state: onchain,
    requireZeroResolver: settings.requireZeroResolver,
    ...(account ? { signer: account } : {}),
  });

  const plan = buildReconciliationPlan({
    desired,
    config: groups,
    onchain,
    batchSize: settings.batchSize,
    addBudget: settings.maxExecutedAddsPerRun,
  });
  const cascadeViolations = findCurrentCascadeViolations(groups, onchain);
  const phase = selectPhase({
    deferredAdds: plan.deferredAdds,
    cascadeViolationCount: cascadeViolations.length,
  });
  assertPlanSafe({
    plan,
    phase,
    allowInitialSeed: settings.allowInitialSeed,
    allowMigrationRemovals: settings.allowMigrationRemovals,
    maxPlannedAdds: settings.maxPlannedAdds,
    maxTotalRemovals: settings.maxTotalRemovals,
    maxRemovalWallets: settings.maxRemovalWallets,
    maxRemovalBpsPerGroup: settings.maxRemovalBpsPerGroup,
  });

  const mutations = mutationsForPhase(plan, phase);

  logger.info(
    {
      rpcLatestBlock: rpcLatestBlock.toString(),
      snapshotBlock: onchain.snapshotBlock.toString(),
      indexedThroughBlock: indexedThroughBlock.toString(),
      phase,
      cascadeViolations,
      totalAdds: plan.totalAdds,
      deferredAdds: plan.deferredAdds,
      totalRemovals: plan.totalRemovals,
      removalWalletCount: plan.removalWalletCount,
      removalReasons: summarizeRemovalReasons(plan, desired, isBlockedWallet),
      removalsExecutable: phase !== "BACKFILL",
      transactionBatches: mutations.length,
      initialSeed: plan.initialSeed,
      groups: plan.groups.map((group) => ({
        scope: group.definition.scope,
        tier: group.definition.tier,
        groupId: group.definition.groupId.toString(),
        currentCount: group.currentCount,
        desiredCount: group.desiredCount,
        adds: group.additions.length,
        deferredAdds: group.deferredAdds,
        removals: group.removals.length,
      })),
    },
    settings.execute ? "Reconciliation plan approved for execution" : "Dry-run reconciliation plan",
  );

  if (!settings.execute || mutations.length === 0) return;
  if (!account || !settings.groupAdminPrivateKey) {
    throw new Error("Execution account is unavailable");
  }
  const executionGovernanceBlock = await publicClient.getBlockNumber();
  const executionGovernanceByGroupId = await loadRegistryGovernance(
    publicClient,
    groups,
    executionGovernanceBlock,
  );
  assertRegistryGovernance({
    config: groups,
    state: {
      ...onchain,
      governanceByGroupId: executionGovernanceByGroupId,
      snapshotBlock: executionGovernanceBlock,
    },
    requireZeroResolver: settings.requireZeroResolver,
    signer: account,
  });
  logger.info(
    { executionGovernanceBlock: executionGovernanceBlock.toString() },
    "Current registry governance revalidated for execution",
  );

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(settings.rpcUrl, { timeout: settings.requestTimeoutMs }),
  });
  const transactionHashes = await executeMutations({
    publicClient,
    walletClient,
    account,
    registryAddress: groups.registryAddress,
    mutations,
    onTransaction: (hash, mutation) =>
      logger.info(
        {
          hash,
          operation: mutation.operation,
          groupId: mutation.groupId,
          members: mutation.members.length,
        },
        "Registry transaction mined",
      ),
  });
  logger.info(
    { phase, transactionCount: transactionHashes.length },
    "On-chain group reconciliation completed",
  );
}
