import type { Address } from "viem";
import type { MakerPlatformStatsRow } from "./indexer.js";

export const USDC_BASE_UNITS = 1_000_000n;
export const TOP_CHARGEBACK_MERCHANT_THRESHOLD_USDC = 10_000n;
export const TOP_CHARGEBACK_MERCHANT_THRESHOLD =
  TOP_CHARGEBACK_MERCHANT_THRESHOLD_USDC * USDC_BASE_UNITS;

export interface MerchantPolicySnapshot {
  members: Set<Address>;
  sourceRows: number;
  qualifyingVolume: bigint;
  threshold: bigint;
}

export function calculateTopChargebackMerchants(
  rows: MakerPlatformStatsRow[],
  threshold = TOP_CHARGEBACK_MERCHANT_THRESHOLD,
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
