import { describe, expect, it } from "vitest";
import type { MakerPlatformStatsRow } from "../src/indexer.js";
import {
  buildMerchantAdditions,
  calculateTopChargebackMerchants,
  TOP_CHARGEBACK_MERCHANT_THRESHOLD,
} from "../src/merchantPolicy.js";
import { CHARGEBACKABLE_PAYMENT_METHOD_HASHES } from "../src/paymentMethods.js";
import { addr } from "./fixtures.js";

function row(
  maker: ReturnType<typeof addr>,
  nonManualReleaseVolume: bigint,
  manualReleaseVolume = 0n,
  paymentMethodHash = CHARGEBACKABLE_PAYMENT_METHOD_HASHES.paypal,
): MakerPlatformStatsRow {
  return {
    id: `8453_${maker}_${paymentMethodHash}`,
    maker,
    paymentMethodHash,
    totalAmountTaken: nonManualReleaseVolume + manualReleaseVolume,
    nonManualReleaseVolume,
    manualReleaseVolume,
  };
}

describe("Top Chargeback Merchants policy", () => {
  it("sums non-manual volume across chargebackable platforms only", () => {
    const maker = addr("1");
    const snapshot = calculateTopChargebackMerchants([
      row(maker, 4_000_000_000n, 100_000_000_000n),
      row(maker, 6_000_000_000n, 0n, CHARGEBACKABLE_PAYMENT_METHOD_HASHES.venmo),
    ]);

    expect(snapshot.threshold).toBe(TOP_CHARGEBACK_MERCHANT_THRESHOLD);
    expect(snapshot.members).toEqual(new Set([maker]));
    expect(snapshot.qualifyingVolume).toBe(10_000_000_000n);
  });

  it("does not let manual-release volume qualify a maker", () => {
    const snapshot = calculateTopChargebackMerchants([
      row(addr("1"), 9_999_999_999n, 999_999_999_999n),
    ]);
    expect(snapshot.members).toEqual(new Set());
  });

  it("plans additions without planning removals", () => {
    const desired = new Set([addr("1"), addr("2")]);
    const current = new Set([addr("2"), addr("3")]);
    expect(buildMerchantAdditions(desired, current)).toEqual({
      additions: [addr("1")],
      unexpectedMembers: [addr("3")],
    });
  });
});
