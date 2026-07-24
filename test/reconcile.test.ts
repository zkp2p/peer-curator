import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  type DesiredSnapshot,
  emptyTierSets,
  type GroupsConfig,
  normalizeAddress,
  POLICY_SCOPES,
  TIERS,
} from "../src/domain.js";
import type { RegistryState } from "../src/onchain.js";
import { assertPlanSafe, buildReconciliationPlan } from "../src/reconcile.js";

const addr = (digit: string): Address => normalizeAddress(`0x${digit.repeat(40)}`);

function fixtures(): {
  desired: DesiredSnapshot;
  config: GroupsConfig;
  onchain: RegistryState;
} {
  const policies = new Map();
  for (const scope of POLICY_SCOPES) {
    policies.set(scope, {
      scope,
      membersByTier: emptyTierSets(),
      sourceRows: 1,
    });
  }
  const groups = POLICY_SCOPES.flatMap((scope, scopeIndex) =>
    TIERS.map((tier, tierIndex) => ({
      scope,
      tier,
      groupId: BigInt(scopeIndex * TIERS.length + tierIndex + 1),
      minimumMembers: 0,
    })),
  );
  return {
    desired: {
      policies,
      blockedWalletCount: 0,
      calculatedAt: "2026-07-24T00:00:00.000Z",
    },
    config: {
      chainId: 8453,
      registryAddress: addr("f"),
      registryDeploymentBlock: 1n,
      groups,
    },
    onchain: {
      membersByGroupId: new Map(groups.map((group) => [group.groupId, new Set<Address>()])),
      governanceByGroupId: new Map(),
      latestBlock: 100n,
    },
  };
}

describe("buildReconciliationPlan", () => {
  it("places all additions before removals and batches deterministically", () => {
    const { desired, config, onchain } = fixtures();
    const a = addr("1");
    const b = addr("2");
    const c = addr("3");
    desired.policies.get("historical-taker")?.membersByTier.PEER.add(a);
    desired.policies.get("historical-taker")?.membersByTier.PEER.add(b);
    onchain.membersByGroupId.set(1n, new Set([b, c]));

    const plan = buildReconciliationPlan({ desired, config, onchain, batchSize: 1 });
    expect(plan.totalAdds).toBe(1);
    expect(plan.totalRemovals).toBe(1);
    expect(plan.mutations.map((mutation) => mutation.operation)).toEqual(["add", "remove"]);
    expect(plan.mutations[0]?.members).toEqual([a]);
    expect(plan.mutations[1]?.members).toEqual([c]);
  });
});

describe("assertPlanSafe", () => {
  it("requires an explicit initial-seed gate", () => {
    const fixture = fixtures();
    fixture.desired.policies.get("historical-taker")?.membersByTier.PEER.add(addr("1"));
    const plan = buildReconciliationPlan({ ...fixture, batchSize: 100 });
    expect(() =>
      assertPlanSafe({
        plan,
        allowInitialSeed: false,
        maxTotalAdds: 10,
        maxTotalRemovals: 10,
        maxRemovalBpsPerGroup: 500,
      }),
    ).toThrow("ALLOW_INITIAL_SEED");
  });

  it("rejects excessive per-group removals", () => {
    const fixture = fixtures();
    const current = new Set([addr("1"), addr("2"), addr("3"), addr("4")]);
    fixture.onchain.membersByGroupId.set(1n, current);
    fixture.desired.policies.get("historical-taker")?.membersByTier.PEER.add(addr("1"));
    const plan = buildReconciliationPlan({ ...fixture, batchSize: 100 });
    expect(() =>
      assertPlanSafe({
        plan,
        allowInitialSeed: true,
        maxTotalAdds: 10,
        maxTotalRemovals: 10,
        maxRemovalBpsPerGroup: 1_000,
      }),
    ).toThrow("removal rate");
  });

  it("enforces minimum expected group size", () => {
    const fixture = fixtures();
    const definition = fixture.config.groups[0];
    if (!definition) throw new Error("fixture missing group");
    definition.minimumMembers = 2;
    fixture.desired.policies.get("historical-taker")?.membersByTier.PEER.add(addr("1"));
    const plan = buildReconciliationPlan({ ...fixture, batchSize: 100 });
    expect(() =>
      assertPlanSafe({
        plan,
        allowInitialSeed: true,
        maxTotalAdds: 10,
        maxTotalRemovals: 10,
        maxRemovalBpsPerGroup: 10_000,
      }),
    ).toThrow("minimumMembers");
  });
});
