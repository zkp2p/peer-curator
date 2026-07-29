import { describe, expect, it } from "vitest";
import { parseGroupsConfig, parsePinnedMembers } from "../src/config.js";
import { POLICY_SCOPES, TIERS } from "../src/domain.js";

function groupsFixture(): unknown {
  return {
    chainId: 8453,
    registryAddress: `0x${"f".repeat(40)}`,
    registryDeploymentBlock: "1",
    groups: POLICY_SCOPES.flatMap((scope, scopeIndex) =>
      TIERS.map((tier, tierIndex) => ({
        scope,
        tier,
        groupId: `0x${(scopeIndex * TIERS.length + tierIndex + 1).toString(16).padStart(64, "0")}`,
        minimumMembers: 1,
        maximumMembers: 10,
      })),
    ),
  };
}

describe("parseGroupsConfig", () => {
  it("accepts a complete three-group manifest", () => {
    expect(parseGroupsConfig(JSON.stringify(groupsFixture())).groups).toHaveLength(3);
  });

  it("rejects an incomplete manifest", () => {
    const fixture = groupsFixture() as { groups: unknown[] };
    fixture.groups = fixture.groups.slice(0, 2);
    expect(() => parseGroupsConfig(JSON.stringify(fixture))).toThrow();
  });

  it("rejects a removed current-Earn group", () => {
    const fixture = groupsFixture() as { groups: { scope: string }[] };
    const first = fixture.groups[0];
    if (!first) throw new Error("fixture missing group");
    first.scope = "current-earn";
    expect(() => parseGroupsConfig(JSON.stringify(fixture))).toThrow();
  });

  it("rejects maximumMembers below minimumMembers", () => {
    const fixture = groupsFixture() as { groups: { maximumMembers: number }[] };
    const first = fixture.groups[0];
    if (!first) throw new Error("fixture missing group");
    first.maximumMembers = 0;
    expect(() => parseGroupsConfig(JSON.stringify(fixture))).toThrow("maximumMembers");
  });

  it("rejects a duplicated scope/tier pair", () => {
    const fixture = groupsFixture() as { groups: { scope: string; tier: string }[] };
    const [first, second] = fixture.groups;
    if (!first || !second) throw new Error("fixture missing groups");
    second.scope = first.scope;
    second.tier = first.tier;
    expect(() => parseGroupsConfig(JSON.stringify(fixture))).toThrow("duplicate scope/tier");
  });
});

describe("parsePinnedMembers", () => {
  it("normalizes valid scope and tier pins", () => {
    expect(
      parsePinnedMembers(
        JSON.stringify([
          {
            scope: "historical-taker",
            tier: "PRO",
            address: `0x${"A".repeat(40)}`,
          },
        ]),
      ),
    ).toEqual([
      {
        scope: "historical-taker",
        tier: "PRO",
        address: `0x${"a".repeat(40)}`,
      },
    ]);
  });

  it("rejects duplicate and invalid pins", () => {
    const pin = {
      scope: "historical-taker",
      tier: "PEER",
      address: `0x${"b".repeat(40)}`,
    };
    expect(() => parsePinnedMembers(JSON.stringify([pin, pin]))).toThrow("duplicate");
    expect(() => parsePinnedMembers(JSON.stringify([{ ...pin, tier: "TOP" }]))).toThrow();
  });

  it("rejects removed current-Earn pins", () => {
    expect(() =>
      parsePinnedMembers(
        JSON.stringify([
          {
            scope: "current-earn",
            tier: "PEER",
            address: `0x${"b".repeat(40)}`,
          },
        ]),
      ),
    ).toThrow();
  });
});
