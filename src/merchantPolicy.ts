import type { Address } from "viem";
import type { MakerPlatformStatsRow } from "./indexer.js";

export const USDC_BASE_UNITS = 1_000_000n;
export const PEER_MAKERS_THRESHOLD_USDC = 10_000n;
export const PEER_MAKERS_THRESHOLD = PEER_MAKERS_THRESHOLD_USDC * USDC_BASE_UNITS;

export interface MerchantPolicySnapshot {
  members: Set<Address>;
  sourceRows: number;
  qualifyingVolume: bigint;
  threshold: bigint;
}

export function calculatePeerMakers(
  rows: MakerPlatformStatsRow[],
  threshold = PEER_MAKERS_THRESHOLD,
): MerchantPolicySnapshot {
  if (threshold <= 0n) {
    throw new Error("Merchant threshold must be positive");
  }
  const volumeByMaker = new Map<Address, bigint>();
  for (const row of rows) {
    volumeByMaker.set(row.maker, (volumeByMaker.get(row.maker) ?? 0n) + row.nonManualReleaseVolume);
  }
  const members = new Set<Address>(
    [...volumeByMaker.entries()]
      .filter(([, volume]) => volume >= threshold)
      .map(([maker]) => maker)
      .sort(),
  );
  return {
    members,
    sourceRows: rows.length,
    qualifyingVolume: [...volumeByMaker.entries()]
      .filter(([maker]) => members.has(maker))
      .reduce((total, [, volume]) => total + volume, 0n),
    threshold,
  };
}

export function buildMerchantAdditions(
  desired: ReadonlySet<Address>,
  current: ReadonlySet<Address>,
): { additions: Address[]; unexpectedMembers: Address[] } {
  return {
    additions: [...desired].filter((address) => !current.has(address)).sort(),
    unexpectedMembers: [...current].filter((address) => !desired.has(address)).sort(),
  };
}

export function budgetMerchantAdditions(
  additions: readonly Address[],
  maximumPerRun: number,
): {
  scheduledAdditions: Address[];
  deferredAdds: number;
} {
  if (!Number.isSafeInteger(maximumPerRun) || maximumPerRun <= 0) {
    throw new Error("Merchant addition budget must be a positive integer");
  }
  const scheduledAdditions = additions.slice(0, maximumPerRun);
  return {
    scheduledAdditions,
    deferredAdds: additions.length - scheduledAdditions.length,
  };
}
