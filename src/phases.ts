import {
  type GroupsConfig,
  groupKey,
  POLICY_SCOPES,
  type PolicyScope,
  TIERS,
  type Tier,
} from "./domain.js";
import type { GroupMutation, RegistryState } from "./onchain.js";
import type { ReconciliationPlan } from "./reconcile.js";

export const RECONCILIATION_PHASES = ["BACKFILL", "MIGRATION_REPAIR", "NORMAL"] as const;
export type ReconciliationPhase = (typeof RECONCILIATION_PHASES)[number];

export interface CascadeViolation {
  scope: PolicyScope;
  higherTier: Tier;
  lowerTier: Tier;
  missingCount: number;
}

/**
 * Counts curated members that sit in a tier without belonging to the tier below.
 * The deployed groups are exclusive, so violations are expected until migration
 * completes; the count drives phase selection rather than throwing.
 */
export function findCurrentCascadeViolations(
  config: GroupsConfig,
  onchain: RegistryState,
): CascadeViolation[] {
  const idByKey = new Map(
    config.groups.map((group) => [groupKey(group.scope, group.tier), group.groupId]),
  );
  const violations: CascadeViolation[] = [];

  for (const scope of POLICY_SCOPES) {
    for (let index = TIERS.length - 1; index > 0; index -= 1) {
      const higherTier = TIERS[index];
      const lowerTier = TIERS[index - 1];
      if (!higherTier || !lowerTier) continue;

      const higherId = idByKey.get(groupKey(scope, higherTier));
      const lowerId = idByKey.get(groupKey(scope, lowerTier));
      if (!higherId || !lowerId) throw new Error(`Missing configured group for ${scope}`);

      const higher = onchain.membersByGroupId.get(higherId);
      const lower = onchain.membersByGroupId.get(lowerId);
      if (!higher || !lower) throw new Error(`Missing on-chain membership for ${scope}`);

      let missingCount = 0;
      for (const member of higher) {
        if (!lower.has(member)) missingCount += 1;
      }
      if (missingCount > 0) violations.push({ scope, higherTier, lowerTier, missingCount });
    }
  }

  return violations;
}

/**
 * Phase is derived from the plan, never from operator state or group emptiness.
 * A model that forbade removals whenever the cascade check failed would
 * deadlock: legacy high-tier memberships are only repairable by removal.
 */
export function selectPhase(input: {
  deferredAdds: number;
  cascadeViolationCount: number;
}): ReconciliationPhase {
  if (input.deferredAdds > 0) return "BACKFILL";
  if (input.cascadeViolationCount > 0) return "MIGRATION_REPAIR";
  return "NORMAL";
}

export function mutationsForPhase(
  plan: ReconciliationPlan,
  phase: ReconciliationPhase,
): GroupMutation[] {
  if (phase === "BACKFILL") return plan.addMutations;
  return [...plan.addMutations, ...plan.removalMutations];
}
