import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { calculateDesiredSnapshot } from "./calculate.js";
import type { RuntimeSettings } from "./config.js";
import { normalizeAddress, tierCounts, tierForAddress } from "./domain.js";
import { IndexerClient } from "./indexer.js";
import type { Logger } from "./logger.js";
import { assertRegistryGovernance, executeMutations, loadRegistryState } from "./onchain.js";
import { findCurrentCascadeViolations, mutationsForPhase, selectPhase } from "./phases.js";
import {
  assertDesiredSnapshotBounds,
  assertDesiredSnapshotComplete,
  assertPlanSafe,
  buildReconciliationPlan,
  summarizeRemovalReasons,
} from "./reconcile.js";
import { isBlockedWallet } from "./staticWalletRules.js";

export class IndexerSnapshotAdvancedError extends Error {
  public constructor() {
    super("Indexer advanced while the reconciliation snapshot was being read");
    this.name = "IndexerSnapshotAdvancedError";
  }
}

export function assertPinnedIndexerSnapshot(input: {
  snapshotBlock: bigint;
  finalIndexedBlock: bigint;
  rpcLatestBlock: bigint;
  confirmationBlocks: bigint;
}): void {
  if (input.finalIndexedBlock !== input.snapshotBlock) {
    throw new IndexerSnapshotAdvancedError();
  }
  if (
    input.rpcLatestBlock < input.confirmationBlocks ||
    input.snapshotBlock > input.rpcLatestBlock - input.confirmationBlocks
  ) {
    throw new Error("Indexer snapshot is not sufficiently confirmed by RPC");
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
  const pinnedIndexerBlock = reconciliationRun ? await indexer.getIndexedThroughBlock() : undefined;
  const desired = await calculateDesiredSnapshot(settings, indexer);

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
    const earn = desired.policies.get("current-earn");
    if (!historical || !earn) throw new Error("Calculated policy snapshot is incomplete");
    logger.info(
      {
        blocked: isBlockedWallet(address),
        highestTier: {
          historicalTaker: tierForAddress(historical, address),
          currentEarn: tierForAddress(earn, address),
        },
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
  if (!settings.rpcUrl) throw new Error("RPC_URL is required");

  const publicClient = createPublicClient({
    chain: base,
    transport: http(settings.rpcUrl, { timeout: settings.requestTimeoutMs }),
  });
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== settings.chainId) {
    throw new Error("RPC chain does not match CHAIN_ID");
  }
  if (pinnedIndexerBlock === undefined) {
    throw new Error("Indexer snapshot block is unavailable");
  }
  const confirmationBlocks = BigInt(settings.snapshotConfirmations);
  const membership = await indexer.getAddressGroupMembershipSnapshot({
    registryAddress: groups.registryAddress,
    groupIds: groups.groups.map((group) => group.groupId),
    deploymentBlock: groups.registryDeploymentBlock,
    snapshotBlock: pinnedIndexerBlock,
  });
  const finalIndexerBlock = await indexer.getIndexedThroughBlock();
  const rpcLatestBlock = await publicClient.getBlockNumber();
  assertPinnedIndexerSnapshot({
    snapshotBlock: pinnedIndexerBlock,
    finalIndexedBlock: finalIndexerBlock,
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
      indexedThroughBlock: onchain.indexedThroughBlock.toString(),
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

export async function runWithSnapshotRetries(
  settings: RuntimeSettings,
  logger: Logger,
  verifyAddress?: string,
  operation: typeof run = run,
): Promise<void> {
  for (let attempt = 1; attempt <= settings.snapshotMaxAttempts; attempt += 1) {
    try {
      await operation(settings, logger, verifyAddress);
      return;
    } catch (error) {
      if (
        !(error instanceof IndexerSnapshotAdvancedError) ||
        attempt === settings.snapshotMaxAttempts
      ) {
        throw error;
      }
      logger.warn(
        { attempt, maxAttempts: settings.snapshotMaxAttempts },
        "Indexer advanced during snapshot; retrying the read-only reconciliation phase",
      );
      await new Promise((resolve) => setTimeout(resolve, settings.snapshotRetryDelayMs));
    }
  }
}
