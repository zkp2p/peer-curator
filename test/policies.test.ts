import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { applyPinnedMembers } from "../src/calculate.js";
import {
  type DesiredSnapshot,
  emptyTierSets,
  normalizeAddress,
  type PolicySnapshot,
  TIERS,
  tierForAddress,
} from "../src/domain.js";
import { CHARGEBACKABLE_PAYMENT_METHOD_HASHES } from "../src/paymentMethods.js";
import {
  calculateHistoricalTakerPolicy,
  classifyTier,
  HISTORICAL_TAKER_POLICY,
} from "../src/policies.js";

const address = (digit: string): Address => normalizeAddress(`0x${digit.repeat(40)}`);

describe("tierForAddress", () => {
  it("returns the highest tier held and PEASANT for outsiders", () => {
    const peer = address("1");
    const outsider = address("2");
    const membersByTier = emptyTierSets();
    membersByTier.PEER.add(peer);
    const snapshot = { scope: "historical-taker" as const, membersByTier, sourceRows: 1 };

    expect(tierForAddress(snapshot, peer)).toBe("PEER");
    expect(tierForAddress(snapshot, outsider)).toBe("PEASANT");
  });
});

describe("pinned members", () => {
  it("adds a pinned Pro wallet to every lower tier", () => {
    const pinned = address("8");
    const historical: PolicySnapshot = {
      scope: "historical-taker" as const,
      membersByTier: emptyTierSets(),
      sourceRows: 0,
    };
    const desired: DesiredSnapshot = {
      policies: new Map([[historical.scope, historical]]),
      blockedWalletCount: 0,
      calculatedAt: "2026-07-28T00:00:00.000Z",
    };

    applyPinnedMembers(
      desired,
      [{ scope: "historical-taker", tier: "PRO", address: pinned }],
      () => false,
    );

    for (const tier of TIERS) expect(historical.membersByTier[tier]).toContain(pinned);
  });

  it("refuses to override the blocked-wallet policy", () => {
    const pinned = address("a");
    const historical: PolicySnapshot = {
      scope: "historical-taker" as const,
      membersByTier: emptyTierSets(),
      sourceRows: 0,
    };
    const desired: DesiredSnapshot = {
      policies: new Map([[historical.scope, historical]]),
      blockedWalletCount: 1,
      calculatedAt: "2026-07-28T00:00:00.000Z",
    };

    expect(() =>
      applyPinnedMembers(
        desired,
        [{ scope: "historical-taker", tier: "PEER", address: pinned }],
        () => true,
      ),
    ).toThrow("blocked wallet");
  });
});

describe("classifyTier", () => {
  it("uses inclusive historical volume thresholds", () => {
    expect(classifyTier(499_999_999n, HISTORICAL_TAKER_POLICY)).toBe("PEASANT");
    expect(classifyTier(500_000_000n, HISTORICAL_TAKER_POLICY)).toBe("PEER");
    expect(classifyTier(2_000_000_000n, HISTORICAL_TAKER_POLICY)).toBe("PLUS");
    expect(classifyTier(10_000_000_000n, HISTORICAL_TAKER_POLICY)).toBe("PRO");
    expect(classifyTier(25_000_000_000n, HISTORICAL_TAKER_POLICY)).toBe("PRO");
  });
});

describe("historical taker policy", () => {
  const platformRow = (
    id: string,
    taker: Address,
    paymentMethodHash: `0x${string}`,
    totalAmountTaken: bigint,
  ) => ({ id, taker, paymentMethodHash, totalAmountTaken });

  it("applies blocklist precedence", () => {
    const peer = address("1");
    const blocked = address("2");
    const pro = address("3");
    const snapshot = calculateHistoricalTakerPolicy({
      takerPlatformStats: [
        platformRow("peer", peer, CHARGEBACKABLE_PAYMENT_METHOD_HASHES.paypal, 500_000_000n),
        platformRow(
          "blocked",
          blocked,
          CHARGEBACKABLE_PAYMENT_METHOD_HASHES.venmo,
          50_000_000_000n,
        ),
        platformRow("pro", pro, CHARGEBACKABLE_PAYMENT_METHOD_HASHES.cashapp, 25_000_000_000n),
      ],
      isBlockedWallet: (candidate) => candidate === blocked,
    });

    expect(snapshot.membersByTier.PEER).toEqual(new Set([peer, pro]));
    expect(snapshot.membersByTier.PLUS).toEqual(new Set([pro]));
    expect(snapshot.membersByTier.PRO).toEqual(new Set([pro]));
    expect([...Object.values(snapshot.membersByTier).flatMap((set) => [...set])]).not.toContain(
      blocked,
    );
  });

  it("sums multiple qualifying platform rows once per wallet and preserves cascading membership", () => {
    const multiPlatform = address("9");
    const snapshot = calculateHistoricalTakerPolicy({
      takerPlatformStats: [
        platformRow(
          "paypal",
          multiPlatform,
          CHARGEBACKABLE_PAYMENT_METHOD_HASHES.paypal,
          1_000_000_000n,
        ),
        platformRow(
          "venmo",
          multiPlatform,
          CHARGEBACKABLE_PAYMENT_METHOD_HASHES.venmo,
          1_000_000_000n,
        ),
      ],
      isBlockedWallet: () => false,
    });

    expect(snapshot.membersByTier.PLUS).toEqual(new Set([multiPlatform]));
    expect(snapshot.membersByTier.PEER).toEqual(new Set([multiPlatform]));
    expect(snapshot.membersByTier.PRO.size).toBe(0);
  });

  it("makes non-chargebackable platform rows contribute zero", () => {
    const mixed = address("7");
    const nonChargebackHash = `0x${"77".repeat(32)}` as const;
    const snapshot = calculateHistoricalTakerPolicy({
      takerPlatformStats: [
        platformRow("paypal", mixed, CHARGEBACKABLE_PAYMENT_METHOD_HASHES.paypal, 499_999_999n),
        platformRow("other", mixed, nonChargebackHash, 50_000_000_000n),
      ],
      isBlockedWallet: () => false,
    });

    for (const tier of TIERS) expect(snapshot.membersByTier[tier].size).toBe(0);
  });

  it("fails closed on duplicate platform rows", () => {
    const duplicate = address("6");
    const row = platformRow(
      "duplicate",
      duplicate,
      CHARGEBACKABLE_PAYMENT_METHOD_HASHES.paypal,
      500_000_000n,
    );

    expect(() =>
      calculateHistoricalTakerPolicy({
        takerPlatformStats: [row, row],
        isBlockedWallet: () => false,
      }),
    ).toThrow("duplicate or invalid platform rows");
  });

  it("excludes a blocked wallet from every curated tier", () => {
    const blocked = address("a");
    const snapshot = calculateHistoricalTakerPolicy({
      takerPlatformStats: [
        platformRow(
          "blocked",
          blocked,
          CHARGEBACKABLE_PAYMENT_METHOD_HASHES.paypal,
          50_000_000_000n,
        ),
      ],
      isBlockedWallet: (candidate) => candidate === blocked,
    });

    for (const tier of TIERS) expect(snapshot.membersByTier[tier].size).toBe(0);
  });
});
