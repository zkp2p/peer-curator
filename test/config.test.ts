import { afterEach, describe, expect, it, vi } from "vitest";
import { V2_HISTORY_REGISTRY_BY_ENVIRONMENT } from "../src/blockPinnedSnapshot.js";
import { loadSettings, parseGroupsConfig, parsePinnedMembers } from "../src/config.js";
import { POLICY_SCOPES, TIERS } from "../src/domain.js";
import { parseMerchantGroupConfig } from "../src/merchantConfig.js";

function groupsFixture(registryAddress: string = `0x${"f".repeat(40)}`): unknown {
  return {
    chainId: 8453,
    registryAddress,
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadSettings", () => {
  it("applies the bounded addition limits when environment overrides are absent", async () => {
    vi.stubEnv("V2_HISTORY_ENVIRONMENT", undefined);
    vi.stubEnv("MAX_PLANNED_ADDS", undefined);
    vi.stubEnv("MAX_EXECUTED_ADDS_PER_RUN", undefined);

    const settings = await loadSettings("calculate");

    expect(settings.maxPlannedAdds).toBe(1_500);
    expect(settings.maxExecutedAddsPerRun).toBe(1_000);
    expect(settings.v2HistoryEnvironment).toBe("prod");
  });

  it("rejects a V2 history selector that mismatches the Railway environment", async () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "staging");
    vi.stubEnv("V2_HISTORY_ENVIRONMENT", "prod");
    await expect(loadSettings("plan")).rejects.toThrow("does not match the Railway environment");
  });

  it("requires a V2 history selector only for reconciliation commands", async () => {
    vi.stubEnv("V2_HISTORY_ENVIRONMENT", undefined);
    await expect(loadSettings("plan")).rejects.toThrow(
      "V2_HISTORY_ENVIRONMENT is required for plan and sync",
    );
    await expect(loadSettings("calculate")).resolves.toMatchObject({
      v2HistoryEnvironment: "prod",
    });
  });

  it("rejects a V2 history selector that mismatches the configured registry", async () => {
    vi.stubEnv("V2_HISTORY_ENVIRONMENT", "staging");
    vi.stubEnv(
      "GROUPS_CONFIG_JSON",
      JSON.stringify(groupsFixture(V2_HISTORY_REGISTRY_BY_ENVIRONMENT.prod)),
    );
    await expect(loadSettings("plan")).rejects.toThrow(
      "does not match the configured AddressGroupRegistry deployment",
    );
  });
});

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

describe("parseMerchantGroupConfig", () => {
  it("accepts an exact empty-cohort safety bound", () => {
    expect(
      parseMerchantGroupConfig(
        JSON.stringify({
          chainId: 8453,
          registryAddress: `0x${"f".repeat(40)}`,
          registryDeploymentBlock: "1",
          groupId: `0x${"1".repeat(64)}`,
          minimumMembers: 0,
          maximumMembers: 0,
        }),
      ),
    ).toMatchObject({
      minimumMembers: 0,
      maximumMembers: 0,
    });
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
