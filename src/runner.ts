import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { calculateDesiredSnapshot } from "./calculate.js";
import type { RuntimeSettings } from "./config.js";
import { tierCounts } from "./domain.js";
import type { Logger } from "./logger.js";
import { assertRegistryGovernance, executeMutations, loadRegistryState } from "./onchain.js";
import {
  assertDesiredSnapshotComplete,
  assertPlanSafe,
  buildReconciliationPlan,
} from "./reconcile.js";

export async function run(settings: RuntimeSettings, logger: Logger): Promise<void> {
  const desired = await calculateDesiredSnapshot(settings);
  assertDesiredSnapshotComplete(desired, settings.groups);

  logger.info(
    {
      calculatedAt: desired.calculatedAt,
      blockedWalletCount: desired.blockedWalletCount,
      policies: [...desired.policies.values()].map((policy) => ({
        scope: policy.scope,
        sourceRows: policy.sourceRows,
        counts: tierCounts(policy),
      })),
    },
    "Desired group membership calculated",
  );

  if (settings.command === "calculate") return;
  if (!settings.rpcUrl) throw new Error("RPC_URL is required");

  const publicClient = createPublicClient({
    chain: base,
    transport: http(settings.rpcUrl, { timeout: settings.requestTimeoutMs }),
  });
  const onchain = await loadRegistryState(publicClient, settings.groups, settings.logBlockRange);
  const account = settings.execute
    ? privateKeyToAccount(settings.groupAdminPrivateKey as `0x${string}`)
    : undefined;
  assertRegistryGovernance({
    config: settings.groups,
    state: onchain,
    requireZeroResolver: settings.requireZeroResolver,
    ...(account ? { signer: account } : {}),
  });

  const plan = buildReconciliationPlan({
    desired,
    config: settings.groups,
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
      latestBlock: onchain.latestBlock.toString(),
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
    registryAddress: settings.groups.registryAddress,
    mutations: plan.mutations,
  });
  logger.info(
    { transactionCount: transactionHashes.length, transactionHashes },
    "On-chain group reconciliation completed",
  );
}
