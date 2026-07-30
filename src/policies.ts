import type { Address } from "viem";
import {
  assertCascadingSets,
  emptyTierSets,
  type PolicySnapshot,
  TIERS,
  type Tier,
} from "./domain.js";
import type { TakerPlatformStatsRow } from "./indexer.js";
import { CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET } from "./paymentMethods.js";

const TIER_ORDER = ["PEASANT", "PEER", "PLUS", "PRO"] as const;
type ComputedTier = (typeof TIER_ORDER)[number];

interface TierPolicy {
  scope: PolicySnapshot["scope"];
  thresholds: Record<Tier, bigint>;
}

export const HISTORICAL_TAKER_POLICY: TierPolicy = {
  scope: "historical-taker",
  thresholds: {
    PEER: 500_000_000n,
    PLUS: 2_000_000_000n,
    PRO: 10_000_000_000n,
  },
};

export function classifyTier(volume: bigint, policy: TierPolicy): ComputedTier {
  if (volume >= policy.thresholds.PRO) return "PRO";
  if (volume >= policy.thresholds.PLUS) return "PLUS";
  if (volume >= policy.thresholds.PEER) return "PEER";
  return "PEASANT";
}

function addMember(snapshot: PolicySnapshot, tier: ComputedTier, address: Address): void {
  if (tier === "PEASANT") return;
  const highestIndex = TIERS.indexOf(tier);
  for (let index = 0; index <= highestIndex; index += 1) {
    const cascadeTier = TIERS[index];
    if (cascadeTier) snapshot.membersByTier[cascadeTier].add(address);
  }
}

export function calculateHistoricalTakerPolicy(input: {
  takerPlatformStats: TakerPlatformStatsRow[];
  isBlockedWallet: (address: Address) => boolean;
}): PolicySnapshot {
  const snapshot: PolicySnapshot = {
    scope: HISTORICAL_TAKER_POLICY.scope,
    membersByTier: emptyTierSets(),
    sourceRows: input.takerPlatformStats.length,
  };

  const seenRowIds = new Set<string>();
  const qualifyingVolumeByTaker = new Map<Address, bigint>();
  for (const row of input.takerPlatformStats) {
    if (!row.id || seenRowIds.has(row.id)) {
      throw new Error("Historical-taker input contains duplicate or invalid platform rows");
    }
    seenRowIds.add(row.id);
    if (!CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET.has(row.paymentMethodHash)) continue;
    qualifyingVolumeByTaker.set(
      row.taker,
      (qualifyingVolumeByTaker.get(row.taker) ?? 0n) + row.totalAmountTaken,
    );
  }

  for (const [taker, qualificationVolume] of qualifyingVolumeByTaker) {
    if (input.isBlockedWallet(taker)) continue;
    addMember(snapshot, classifyTier(qualificationVolume, HISTORICAL_TAKER_POLICY), taker);
  }

  assertCascadingSets(snapshot.membersByTier, snapshot.scope);
  return snapshot;
}
