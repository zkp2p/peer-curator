import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  assertCascadingSets,
  emptyTierSets,
  normalizeAddress,
  type PolicySnapshot,
  TIERS,
  tierCounts,
  tierForAddress,
} from "../src/domain.js";

const address = (digit: string): Address => normalizeAddress(`0x${digit.repeat(40)}`);

function snapshotOf(members: Address[][]): PolicySnapshot {
  const membersByTier = emptyTierSets();
  TIERS.forEach((tier, index) => {
    for (const member of members[index] ?? []) membersByTier[tier].add(member);
  });
  return { scope: "historical-taker", membersByTier, sourceRows: 1 };
}

describe("TIERS", () => {
  it("is an ascending ladder with PEASANT at the floor", () => {
    expect(TIERS).toEqual(["PEASANT", "PEER", "PLUS", "PRO"]);
  });
});

describe("tierForAddress", () => {
  it("returns the highest tier held, not the lowest", () => {
    const pro = address("1");
    expect(tierForAddress(snapshotOf([[pro], [pro], [pro], [pro]]), pro)).toBe("PRO");
  });

  it("returns the highest tier for a mid-ladder member", () => {
    const plus = address("2");
    expect(tierForAddress(snapshotOf([[plus], [plus], [plus], []]), plus)).toBe("PLUS");
  });

  it("returns NONE for an address in no tier", () => {
    expect(tierForAddress(snapshotOf([]), address("3"))).toBe("NONE");
  });
});

describe("tierCounts", () => {
  it("reports cumulative counts across all four tiers", () => {
    const peasant = address("4");
    const pro = address("5");
    const snapshot = snapshotOf([[peasant, pro], [pro], [pro], [pro]]);
    expect(tierCounts(snapshot)).toEqual({ PEASANT: 2, PEER: 1, PLUS: 1, PRO: 1 });
  });
});

describe("assertCascadingSets", () => {
  it("accepts a valid prefix", () => {
    const pro = address("6");
    const snapshot = snapshotOf([[pro], [pro], [pro], [pro]]);
    expect(() => assertCascadingSets(snapshot.membersByTier, "historical-taker")).not.toThrow();
  });

  it("throws when a higher tier member is missing from the tier below", () => {
    const orphan = address("7");
    const snapshot = snapshotOf([[orphan], [orphan], [], [orphan]]);
    expect(() => assertCascadingSets(snapshot.membersByTier, "historical-taker")).toThrow(
      "not cascading",
    );
  });
});
