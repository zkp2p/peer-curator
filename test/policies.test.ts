import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { normalizeAddress } from "../src/domain.js";
import {
  CURRENT_EARN_POLICY,
  calculateCurrentEarnPolicy,
  calculateHistoricalTakerPolicy,
  classifyTier,
  HISTORICAL_TAKER_POLICY,
} from "../src/policies.js";

const address = (digit: string): Address => normalizeAddress(`0x${digit.repeat(40)}`);

describe("classifyTier", () => {
  it("uses inclusive historical volume thresholds", () => {
    expect(classifyTier(499_999_999n, 0n, 0n, HISTORICAL_TAKER_POLICY)).toBe("PEASANT");
    expect(classifyTier(500_000_000n, 0n, 0n, HISTORICAL_TAKER_POLICY)).toBe("PEER");
    expect(classifyTier(2_000_000_000n, 0n, 0n, HISTORICAL_TAKER_POLICY)).toBe("PLUS");
    expect(classifyTier(10_000_000_000n, 0n, 0n, HISTORICAL_TAKER_POLICY)).toBe("PRO");
    expect(classifyTier(25_000_000_000n, 0n, 0n, HISTORICAL_TAKER_POLICY)).toBe("PLATINUM");
  });

  it("demotes one level per crossed lock-score threshold", () => {
    const volume = 25_000_000_000n;
    expect(classifyTier(volume, volume * 50n, volume, HISTORICAL_TAKER_POLICY)).toBe("PRO");
    expect(classifyTier(volume, volume * 200n, volume, HISTORICAL_TAKER_POLICY)).toBe("PLUS");
    expect(classifyTier(volume, volume * 1_000n, volume, HISTORICAL_TAKER_POLICY)).toBe("PEASANT");
  });

  it("uses the 250 USDC dilution floor", () => {
    expect(classifyTier(2_000_000_000n, 250_000_000n * 49n, 0n, HISTORICAL_TAKER_POLICY)).toBe(
      "PLUS",
    );
    expect(classifyTier(2_000_000_000n, 250_000_000n * 50n, 0n, HISTORICAL_TAKER_POLICY)).toBe(
      "PEER",
    );
  });
});

describe("historical taker policy", () => {
  it("applies blocklist precedence and Platinum overrides", () => {
    const peer = address("1");
    const blocked = address("2");
    const override = address("3");
    const snapshot = calculateHistoricalTakerPolicy({
      takerStats: [
        {
          id: `8453_${peer}`,
          owner: peer,
          totalFulfilledVolume: 500_000_000n,
          lockScore: 0n,
        },
        {
          id: `8453_${blocked}`,
          owner: blocked,
          totalFulfilledVolume: 50_000_000_000n,
          lockScore: 0n,
        },
      ],
      blockedWallets: new Set([blocked]),
      platinumOverrides: new Set([override]),
    });

    expect(snapshot.membersByTier.PEER).toEqual(new Set([peer]));
    expect(snapshot.membersByTier.PLATINUM).toEqual(new Set([override]));
    expect([...Object.values(snapshot.membersByTier).flatMap((set) => [...set])]).not.toContain(
      blocked,
    );
  });
});

describe("current Earn policy", () => {
  it("aggregates frozen platform volume and post-cutover Peer Pay volume", () => {
    const maker = address("4");
    const peerPayOnly = address("5");
    const blocked = address("6");
    const snapshot = calculateCurrentEarnPolicy({
      platformStats: [
        {
          id: `8453_${maker}_a`,
          maker,
          paymentMethodHash: "a",
          totalAmountTakenPreEarnCutover: 6_000_000_000n,
        },
        {
          id: `8453_${maker}_b`,
          maker,
          paymentMethodHash: "b",
          totalAmountTakenPreEarnCutover: 5_000_000_000n,
        },
        {
          id: `8453_${blocked}_a`,
          maker: blocked,
          paymentMethodHash: "a",
          totalAmountTakenPreEarnCutover: 200_000_000_000n,
        },
      ],
      peerPayStats: [
        {
          id: `8453_${maker}`,
          maker,
          ppTakenPostEarnCutover: 1_000_000_000n,
        },
        {
          id: `8453_${peerPayOnly}`,
          maker: peerPayOnly,
          ppTakenPostEarnCutover: 1_000_000_000n,
        },
      ],
      takerStats: [],
      blockedWallets: new Set([blocked]),
    });

    expect(snapshot.membersByTier.PLUS).toEqual(new Set([maker]));
    expect(snapshot.membersByTier.PEER).toEqual(new Set([peerPayOnly]));
    expect(classifyTier(100_000_000_000n, 0n, 0n, CURRENT_EARN_POLICY)).toBe("PLATINUM");
  });
});
