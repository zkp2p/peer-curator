import type { Address } from "viem";
import {
  type DesiredSnapshot,
  type GroupDefinition,
  type GroupsConfig,
  groupKey,
  POLICY_SCOPES,
  TIERS,
} from "./domain.js";
import type { GroupMutation, RegistryState } from "./onchain.js";

export interface GroupPlan {
  definition: GroupDefinition;
  currentCount: number;
  desiredCount: number;
  additions: Address[];
  removals: Address[];
}

export interface ReconciliationPlan {
  groups: GroupPlan[];
  mutations: GroupMutation[];
  totalAdds: number;
  totalRemovals: number;
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
    };
  });

  const addMutations = groups.flatMap((group) =>
    chunks(group.additions, input.batchSize).map(
      (members): GroupMutation => ({
        operation: "add",
        groupId: group.definition.groupId,
        members,
      }),
    ),
  );
  const removeMutations = groups.flatMap((group) =>
    chunks(group.removals, input.batchSize).map(
      (members): GroupMutation => ({
        operation: "remove",
        groupId: group.definition.groupId,
        members,
      }),
    ),
  );

  return {
    groups,
    mutations: [...addMutations, ...removeMutations],
    totalAdds: groups.reduce((total, group) => total + group.additions.length, 0),
    totalRemovals: groups.reduce((total, group) => total + group.removals.length, 0),
    initialSeed: groups.every((group) => group.currentCount === 0),
  };
}

export function assertDesiredSnapshotComplete(
  desired: DesiredSnapshot,
  config: GroupsConfig,
): void {
  for (const scope of POLICY_SCOPES) {
    const policy = desired.policies.get(scope);
    if (!policy) throw new Error(`Missing policy snapshot ${scope}`);

    const seen = new Set<Address>();
    for (const tier of TIERS) {
      for (const address of policy.membersByTier[tier]) {
        if (seen.has(address)) {
          throw new Error(`${scope} contains duplicate cross-tier membership`);
        }
        seen.add(address);
      }
      if (
        !config.groups.some((group) => groupKey(group.scope, group.tier) === groupKey(scope, tier))
      ) {
        throw new Error(`Missing configured group for ${scope}:${tier}`);
      }
    }
  }
}

export function assertPlanSafe(input: {
  plan: ReconciliationPlan;
  allowInitialSeed: boolean;
  maxTotalAdds: number;
  maxTotalRemovals: number;
  maxRemovalBpsPerGroup: number;
}): void {
  if (input.plan.initialSeed && !input.allowInitialSeed && input.plan.totalAdds > 0) {
    throw new Error("Initial seed requires ALLOW_INITIAL_SEED=true");
  }
  if (input.plan.totalAdds > input.maxTotalAdds) {
    throw new Error(
      `Planned additions ${input.plan.totalAdds} exceed MAX_TOTAL_ADDS ${input.maxTotalAdds}`,
    );
  }
  if (input.plan.totalRemovals > input.maxTotalRemovals) {
    throw new Error(
      `Planned removals ${input.plan.totalRemovals} exceed MAX_TOTAL_REMOVALS ${input.maxTotalRemovals}`,
    );
  }

  for (const group of input.plan.groups) {
    if (group.desiredCount < group.definition.minimumMembers) {
      throw new Error(
        `${group.definition.scope}:${group.definition.tier} desired count ${group.desiredCount} is below minimumMembers ${group.definition.minimumMembers}`,
      );
    }
    if (group.currentCount === 0 || group.removals.length === 0) continue;
    const removalBps = Math.ceil((group.removals.length * 10_000) / group.currentCount);
    if (removalBps > input.maxRemovalBpsPerGroup) {
      throw new Error(
        `${group.definition.scope}:${group.definition.tier} removal rate ${removalBps} bps exceeds limit ${input.maxRemovalBpsPerGroup}`,
      );
    }
  }
}
