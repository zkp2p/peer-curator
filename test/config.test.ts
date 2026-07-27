import { describe, expect, it } from "vitest";
import { parseGroupsConfig } from "../src/config.js";
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
  it("accepts a complete eight-group manifest", () => {
    expect(parseGroupsConfig(JSON.stringify(groupsFixture())).groups).toHaveLength(8);
  });

  it("rejects a legacy six-group manifest", () => {
    const fixture = groupsFixture() as { groups: unknown[] };
    fixture.groups = fixture.groups.slice(0, 6);
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
