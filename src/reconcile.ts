import type { Address } from "viem";
import {
  assertCascadingSets,
  type DesiredSnapshot,
  type GroupDefinition,
  type GroupsConfig,
  groupKey,
  POLICY_SCOPES,
  TIERS,
  tierCounts,
} from "./domain.js";
import type { GroupMutation, RegistryState } from "./onchain.js";
import type { ReconciliationPhase } from "./phases.js";

export interface GroupPlan {
  definition: GroupDefinition;
  currentCount: number;
  desiredCount: number;
  additions: Address[];
  removals: Address[];
  deferredAdds: number;
}

/**
 * `additions`, `removals`, `totalAdds` and `totalRemovals` describe the FULL
 * pre-truncation plan and are what validation reasons about. `addMutations` is
 * post-truncation — only what this run will execute.
 */
export interface ReconciliationPlan {
  groups: GroupPlan[];
  addMutations: GroupMutation[];
  removalMutations: GroupMutation[];
  totalAdds: number;
  totalRemovals: number;
  deferredAdds: number;
  removalWalletCount: number;
  initialSeed: boolean;
}

function sortedDifference(left: Set<Address>, right: Set<Address>): Address[] {
  return [...left].filter((address) => !right.has(address)).sort();
}

function chunks<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function getDesiredMembers(desired: DesiredSnapshot, definition: GroupDefinition): Set<Address> {
  const policy = desired.policies.get(definition.scope);
  if (!policy) throw new Error(`Missing desired policy ${definition.scope}`);
  return policy.membersByTier[definition.tier];
}

export function buildReconciliationPlan(input: {
  desired: DesiredSnapshot;
  config: GroupsConfig;
  onchain: RegistryState;
  batchSize: number;
  addBudget: number;
}): ReconciliationPlan {
  const groups = input.config.groups.map((definition): GroupPlan => {
    const current = input.onchain.membersByGroupId.get(definition.groupId);
    if (!current) throw new Error(`Missing on-chain state for group ${definition.groupId}`);
    const desired = getDesiredMembers(input.desired, definition);
    return {
      definition,
      currentCount: current.size,
      desiredCount: desired.size,
      additions: sortedDifference(desired, current),
      removals: sortedDifference(current, desired),
      deferredAdds: 0,
    };
  });

  const tierRank = (plan: GroupPlan) => TIERS.indexOf(plan.definition.tier);
  const ascending = [...groups].sort((left, right) => tierRank(left) - tierRank(right));
  const descending = [...groups].sort((left, right) => tierRank(right) - tierRank(left));

  let remainingBudget = Math.max(0, input.addBudget);
  const addMutations: GroupMutation[] = [];
  for (const group of ascending) {
    const scheduled = group.additions.slice(0, remainingBudget);
    group.deferredAdds = group.additions.length - scheduled.length;
    remainingBudget -= scheduled.length;
    for (const members of chunks(scheduled, input.batchSize)) {
      addMutations.push({ operation: "add", groupId: group.definition.groupId, members });
    }
  }

  const removalMutations = descending.flatMap((group) =>
    chunks(group.removals, input.batchSize).map(
      (members): GroupMutation => ({
        operation: "remove",
        groupId: group.definition.groupId,
        members,
      }),
    ),
  );

  const removalWallets = new Set<Address>();
  for (const group of groups) {
    for (const address of group.removals) removalWallets.add(address);
  }

  return {
    groups,
    addMutations,
    removalMutations,
    totalAdds: groups.reduce((total, group) => total + group.additions.length, 0),
    totalRemovals: groups.reduce((total, group) => total + group.removals.length, 0),
    deferredAdds: groups.reduce((total, group) => total + group.deferredAdds, 0),
    removalWalletCount: removalWallets.size,
    initialSeed: groups.every((group) => group.currentCount === 0),
  };
}

export const REMOVAL_REASONS = ["blocked", "demoted", "not-a-candidate"] as const;
export type RemovalReason = (typeof REMOVAL_REASONS)[number];

/**
 * Categorises planned removals for the migration approval report. "demoted"
 * means the wallet is still curated in this scope but at a lower tier;
 * "not-a-candidate" covers wallets that left the source set entirely, which
 * includes legacy and manually-added registry memberships.
 */
export function summarizeRemovalReasons(
  plan: ReconciliationPlan,
  desired: DesiredSnapshot,
  isBlocked: (address: Address) => boolean,
): Record<RemovalReason, number> {
  const totals: Record<RemovalReason, number> = {
    blocked: 0,
    demoted: 0,
    "not-a-candidate": 0,
  };

  for (const group of plan.groups) {
    const policy = desired.policies.get(group.definition.scope);
    if (!policy) throw new Error(`Missing desired policy ${group.definition.scope}`);
    for (const address of group.removals) {
      if (isBlocked(address)) {
        totals.blocked += 1;
      } else if (TIERS.some((tier) => policy.membersByTier[tier].has(address))) {
        totals.demoted += 1;
      } else {
        totals["not-a-candidate"] += 1;
      }
    }
  }

  return totals;
}

export function assertDesiredSnapshotComplete(
  desired: DesiredSnapshot,
  config: GroupsConfig,
): void {
  for (const scope of POLICY_SCOPES) {
    const policy = desired.policies.get(scope);
    if (!policy) throw new Error(`Missing policy snapshot ${scope}`);
    assertCascadingSets(policy.membersByTier, scope);

    for (const tier of TIERS) {
      if (
        !config.groups.some((group) => groupKey(group.scope, group.tier) === groupKey(scope, tier))
      ) {
        throw new Error(`Missing configured group for ${scope}:${tier}`);
      }
    }
  }
}

/**
 * Validates the calculated snapshot without reference to on-chain state, so a
 * bad calculation is caught even when the resulting diff happens to be small.
 * The monotonicity check is deliberately redundant with assertCascadingSets —
 * it is a cheap independent cross-check on the same invariant.
 */
export function assertDesiredSnapshotBounds(desired: DesiredSnapshot, config: GroupsConfig): void {
  for (const scope of POLICY_SCOPES) {
    const policy = desired.policies.get(scope);
    if (!policy) throw new Error(`Missing policy snapshot ${scope}`);
    const counts = tierCounts(policy);

    for (const definition of config.groups.filter((group) => group.scope === scope)) {
      const count = counts[definition.tier];
      if (count < definition.minimumMembers) {
        throw new Error(
          `${scope}:${definition.tier} desired count ${count} is below minimumMembers ${definition.minimumMembers}`,
        );
      }
      if (count > definition.maximumMembers) {
        throw new Error(
          `${scope}:${definition.tier} desired count ${count} exceeds maximumMembers ${definition.maximumMembers}`,
        );
      }
    }

    for (let index = TIERS.length - 1; index > 0; index -= 1) {
      const higher = TIERS[index];
      const lower = TIERS[index - 1];
      if (!higher || !lower) continue;
      if (counts[higher] > counts[lower]) {
        throw new Error(
          `${scope} tier counts are not monotonic: ${higher} ${counts[higher]} exceeds ${lower} ${counts[lower]}`,
        );
      }
    }
  }
}

export function assertPlanSafe(input: {
  plan: ReconciliationPlan;
  phase: ReconciliationPhase;
  allowInitialSeed: boolean;
  allowMigrationRemovals: boolean;
  maxPlannedAdds: number;
  maxTotalRemovals: number;
  maxRemovalWallets: number;
  maxRemovalBpsPerGroup: number;
}): void {
  if (input.plan.initialSeed && !input.allowInitialSeed && input.plan.totalAdds > 0) {
    throw new Error("Initial seed requires ALLOW_INITIAL_SEED=true");
  }
  if (input.plan.totalAdds > input.maxPlannedAdds) {
    throw new Error(
      `Planned additions ${input.plan.totalAdds} exceed MAX_PLANNED_ADDS ${input.maxPlannedAdds}`,
    );
  }

  if (input.phase === "BACKFILL") return;

  if (input.phase === "MIGRATION_REPAIR" && !input.allowMigrationRemovals) {
    throw new Error("Migration repair requires ALLOW_MIGRATION_REMOVALS=true");
  }
  if (input.plan.totalRemovals > input.maxTotalRemovals) {
    throw new Error(
      `Planned removals ${input.plan.totalRemovals} exceed MAX_TOTAL_REMOVALS ${input.maxTotalRemovals}`,
    );
  }
  if (input.plan.removalWalletCount > input.maxRemovalWallets) {
    throw new Error(
      `Removals affect ${input.plan.removalWalletCount} wallets, exceeding MAX_REMOVAL_WALLETS ${input.maxRemovalWallets}`,
    );
  }

  for (const group of input.plan.groups) {
    if (group.currentCount === 0 || group.removals.length === 0) continue;
    const removalBps = Math.ceil((group.removals.length * 10_000) / group.currentCount);
    if (removalBps > input.maxRemovalBpsPerGroup) {
      throw new Error(
        `${group.definition.scope}:${group.definition.tier} removal rate ${removalBps} bps exceeds limit ${input.maxRemovalBpsPerGroup}`,
      );
    }
  }
}
