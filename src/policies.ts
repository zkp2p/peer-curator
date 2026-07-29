import type { Address } from "viem";
import {
  assertCascadingSets,
  emptyTierSets,
  type PolicySnapshot,
  TIERS,
  type Tier,
} from "./domain.js";
import type { TakerStatsRow } from "./indexer.js";

const TIER_ORDER = ["PEASANT", "PEER", "PLUS", "PRO", "TOP"] as const;
type ComputedTier = (typeof TIER_ORDER)[number];
type ThresholdTier = Exclude<ComputedTier, "PEASANT">;

interface TierPolicy {
  scope: PolicySnapshot["scope"];
  thresholds: Record<ThresholdTier, bigint>;
  lockScorePenaltyThresholds: readonly bigint[];
}

export const HISTORICAL_TAKER_POLICY: TierPolicy = {
  scope: "historical-taker",
  thresholds: {
    PEER: 500_000_000n,
    PLUS: 2_000_000_000n,
    PRO: 10_000_000_000n,
    TOP: 25_000_000_000n,
  },
  lockScorePenaltyThresholds: [50n, 200n, 500n, 1_000n],
};

const LOCK_SCORE_FLOOR = 250_000_000n;

export function classifyTier(
  volume: bigint,
  lockScore: bigint,
  fulfilledTakerVolume: bigint,
  policy: TierPolicy,
): ComputedTier {
  let baseTier: ComputedTier = "PEASANT";
  if (volume >= policy.thresholds.TOP) baseTier = "TOP";
  else if (volume >= policy.thresholds.PRO) baseTier = "PRO";
  else if (volume >= policy.thresholds.PLUS) baseTier = "PLUS";
  else if (volume >= policy.thresholds.PEER) baseTier = "PEER";

  const denominator =
    fulfilledTakerVolume > LOCK_SCORE_FLOOR ? fulfilledTakerVolume : LOCK_SCORE_FLOOR;
  const dilutedLockScore = lockScore / denominator;
  const penaltyLevels = policy.lockScorePenaltyThresholds.filter(
    (threshold) => dilutedLockScore >= threshold,
  ).length;
  return TIER_ORDER[Math.max(0, TIER_ORDER.indexOf(baseTier) - penaltyLevels)] ?? "PEASANT";
}

function addMember(snapshot: PolicySnapshot, tier: ComputedTier, address: Address): void {
  if (tier === "PEASANT") return;
  const publicTier: Tier = tier === "TOP" ? "PRO" : tier;
  const highestIndex = TIERS.indexOf(publicTier);
  for (let index = 0; index <= highestIndex; index += 1) {
    const cascadeTier = TIERS[index];
    if (cascadeTier) snapshot.membersByTier[cascadeTier].add(address);
  }
}

export function calculateHistoricalTakerPolicy(input: {
  takerStats: TakerStatsRow[];
  isBlockedWallet: (address: Address) => boolean;
}): PolicySnapshot {
  const snapshot: PolicySnapshot = {
    scope: HISTORICAL_TAKER_POLICY.scope,
    membersByTier: emptyTierSets(),
    sourceRows: input.takerStats.length,
  };

  for (const row of input.takerStats) {
    if (input.isBlockedWallet(row.owner)) continue;
    const tier = classifyTier(
      row.totalFulfilledVolume,
      row.lockScore,
      row.totalFulfilledVolume,
      HISTORICAL_TAKER_POLICY,
    );
    addMember(snapshot, tier, row.owner);
  }

  assertCascadingSets(snapshot.membersByTier, snapshot.scope);
  return snapshot;
}
