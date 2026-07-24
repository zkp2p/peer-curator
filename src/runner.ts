import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { calculateDesiredSnapshot } from "./calculate.js";
import type { RuntimeSettings } from "./config.js";
import { normalizeAddress, tierCounts, tierForAddress } from "./domain.js";
import { IndexerClient } from "./indexer.js";
import type { Logger } from "./logger.js";
import { assertRegistryGovernance, executeMutations, loadRegistryState } from "./onchain.js";
import {
  assertDesiredSnapshotComplete,
  assertPlanSafe,
  buildReconciliationPlan,
} from "./reconcile.js";
import { isBlockedWallet } from "./staticWalletRules.js";

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
  const desired = await calculateDesiredSnapshot(settings, indexer);

  logger.info(
    {
      calculatedAt: desired.calculatedAt,
      indexerAccess: settings.indexerApiKey ? "api-key" : "public-rate-limited",
      blockedWalletCount: desired.blockedWalletCount,
      policies: [...desired.policies.values()].map((policy) => ({
        scope: policy.scope,
        sourceRows: policy.sourceRows,
        counts: tierCounts(policy),
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
        tiers: {
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
  if (!settings.rpcUrl) throw new Error("RPC_URL is required");

  const publicClient = createPublicClient({
    chain: base,
    transport: http(settings.rpcUrl, { timeout: settings.requestTimeoutMs }),
  });
  const [rpcChainId, rpcLatestBlock] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlockNumber(),
  ]);
  if (rpcChainId !== settings.chainId) {
    throw new Error("RPC chain does not match CHAIN_ID");
  }
  const confirmationBlocks = BigInt(settings.snapshotConfirmations);
  if (rpcLatestBlock < confirmationBlocks) {
    throw new Error("RPC chain height is below SNAPSHOT_CONFIRMATIONS");
  }
  const snapshotBlock = rpcLatestBlock - confirmationBlocks;
  const membership = await indexer.getAddressGroupMembershipSnapshot({
    registryAddress: groups.registryAddress,
    groupIds: groups.groups.map((group) => group.groupId),
    deploymentBlock: groups.registryDeploymentBlock,
    snapshotBlock,
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
  });
  assertPlanSafe({
    plan,
    allowInitialSeed: settings.allowInitialSeed,
    maxTotalAdds: settings.maxTotalAdds,
    maxTotalRemovals: settings.maxTotalRemovals,
    maxRemovalBpsPerGroup: settings.maxRemovalBpsPerGroup,
  });

  logger.info(
    {
      rpcLatestBlock: rpcLatestBlock.toString(),
      snapshotBlock: onchain.snapshotBlock.toString(),
      indexedThroughBlock: onchain.indexedThroughBlock.toString(),
      totalAdds: plan.totalAdds,
      totalRemovals: plan.totalRemovals,
      transactionBatches: plan.mutations.length,
      initialSeed: plan.initialSeed,
      groups: plan.groups.map((group) => ({
        scope: group.definition.scope,
        tier: group.definition.tier,
        groupId: group.definition.groupId.toString(),
        currentCount: group.currentCount,
        desiredCount: group.desiredCount,
        adds: group.additions.length,
        removals: group.removals.length,
      })),
    },
    settings.execute ? "Reconciliation plan approved for execution" : "Dry-run reconciliation plan",
  );

  if (!settings.execute || plan.mutations.length === 0) return;
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
    mutations: plan.mutations,
  });
  logger.info(
    { transactionCount: transactionHashes.length, transactionHashes },
    "On-chain group reconciliation completed",
  );
}
