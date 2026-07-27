import type { Address } from "viem";
import {
  assertCascadingSets,
  emptyTierSets,
  type PolicySnapshot,
  TIERS,
  type Tier,
} from "./domain.js";
import type { MakerPeerPayStatsRow, MakerPlatformStatsRow, TakerStatsRow } from "./indexer.js";

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

export const CURRENT_EARN_POLICY: TierPolicy = {
  scope: "current-earn",
  thresholds: {
    PEER: 1_000_000_000n,
    PLUS: 10_000_000_000n,
    PRO: 50_000_000_000n,
    TOP: 100_000_000_000n,
  },
  lockScorePenaltyThresholds: [100n, 400n, 1_000n, 2_000n],
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

export function calculateCurrentEarnPolicy(input: {
  platformStats: MakerPlatformStatsRow[];
  peerPayStats: MakerPeerPayStatsRow[];
  takerStats: TakerStatsRow[];
  isBlockedWallet: (address: Address) => boolean;
}): PolicySnapshot {
  const snapshot: PolicySnapshot = {
    scope: CURRENT_EARN_POLICY.scope,
    membersByTier: emptyTierSets(),
    sourceRows: input.platformStats.length + input.peerPayStats.length,
  };

  const preEarnVolume = new Map<Address, bigint>();
  for (const row of input.platformStats) {
    preEarnVolume.set(
      row.maker,
      (preEarnVolume.get(row.maker) ?? 0n) + row.totalAmountTakenPreEarnCutover,
    );
  }

  const postEarnPeerPayVolume = new Map<Address, bigint>();
  for (const row of input.peerPayStats) {
    postEarnPeerPayVolume.set(
      row.maker,
      (postEarnPeerPayVolume.get(row.maker) ?? 0n) + row.ppTakenPostEarnCutover,
    );
  }

  const takerByOwner = new Map(input.takerStats.map((row) => [row.owner, row]));
  const candidates = new Set([...preEarnVolume.keys(), ...postEarnPeerPayVolume.keys()]);
  for (const address of candidates) {
    if (input.isBlockedWallet(address)) continue;
    const volume = (preEarnVolume.get(address) ?? 0n) + (postEarnPeerPayVolume.get(address) ?? 0n);
    const takerStats = takerByOwner.get(address);
    const tier = classifyTier(
      volume,
      takerStats?.lockScore ?? 0n,
      takerStats?.totalFulfilledVolume ?? 0n,
      CURRENT_EARN_POLICY,
    );
    addMember(snapshot, tier, address);
  }

  assertCascadingSets(snapshot.membersByTier, snapshot.scope);
  return snapshot;
}
