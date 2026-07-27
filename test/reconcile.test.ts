import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { TIERS } from "../src/domain.js";
import { findCurrentCascadeViolations, selectPhase } from "../src/phases.js";
import {
  assertDesiredSnapshotBounds,
  assertDesiredSnapshotComplete,
  assertPlanSafe,
  buildReconciliationPlan,
  summarizeRemovalReasons,
} from "../src/reconcile.js";
import { addr, applyMutations, groupId, planFixture } from "./fixtures.js";

describe("buildReconciliationPlan", () => {
  it("orders adds lowest tier first and removals highest tier first, regardless of config order", () => {
    const { desired, config, onchain } = planFixture();
    config.groups.reverse();
    const wallet = addr("1");
    const policy = desired.policies.get("historical-taker");
    policy?.membersByTier.PEASANT.add(wallet);
    policy?.membersByTier.PEER.add(wallet);
    onchain.membersByGroupId.set(groupId(3), new Set([addr("2")]));
    onchain.membersByGroupId.set(groupId(4), new Set([addr("2")]));

    const plan = buildReconciliationPlan({
      desired,
      config,
      onchain,
      batchSize: 100,
      addBudget: 100,
    });
    const tierOf = (mutation: { groupId: string }) =>
      config.groups.find((group) => group.groupId === mutation.groupId)?.tier;

    expect(plan.addMutations.map(tierOf)).toEqual(["PEASANT", "PEER"]);
    expect(plan.removalMutations.map(tierOf)).toEqual(["PRO", "PLUS"]);
  });

  it("truncates adds at the budget and reports the deferred remainder", () => {
    const { desired, config, onchain } = planFixture();
    const policy = desired.policies.get("historical-taker");
    for (const digit of ["1", "2", "3"]) policy?.membersByTier.PEASANT.add(addr(digit));

    const plan = buildReconciliationPlan({
      desired,
      config,
      onchain,
      batchSize: 100,
      addBudget: 2,
    });

    expect(plan.totalAdds).toBe(3);
    expect(plan.deferredAdds).toBe(1);
    expect(plan.addMutations.flatMap((mutation) => mutation.members)).toHaveLength(2);
  });

  it("leaves a valid cascade prefix at every budget boundary", () => {
    const wallet = addr("1");
    for (let budget = 0; budget <= 5; budget += 1) {
      const { desired, config, onchain } = planFixture();
      const policy = desired.policies.get("historical-taker");
      for (const tier of TIERS) policy?.membersByTier[tier].add(wallet);

      const plan = buildReconciliationPlan({
        desired,
        config,
        onchain,
        batchSize: 100,
        addBudget: budget,
      });
      applyMutations(onchain, plan.addMutations);

      const held = TIERS.map(
        (_, index) => onchain.membersByGroupId.get(groupId(index + 1))?.has(wallet) ?? false,
      );
      const firstMissing = held.indexOf(false);
      const isPrefix = firstMissing === -1 || !held.slice(firstMissing).includes(true);
      expect(isPrefix).toBe(true);
    }
  });

  it("converges over repeated runs when the budget cuts before prerequisite adds", () => {
    const { desired, config, onchain } = planFixture();
    const policy = desired.policies.get("historical-taker");
    for (const digit of ["1", "2", "3"]) {
      for (const tier of TIERS) policy?.membersByTier[tier].add(addr(digit));
    }

    let plan = buildReconciliationPlan({ desired, config, onchain, batchSize: 100, addBudget: 2 });
    let runs = 0;
    while (plan.deferredAdds > 0 && runs < 20) {
      applyMutations(onchain, plan.addMutations);
      plan = buildReconciliationPlan({ desired, config, onchain, batchSize: 100, addBudget: 2 });
      runs += 1;
    }
    applyMutations(onchain, plan.addMutations);

    expect(plan.deferredAdds).toBe(0);
    expect(runs).toBeLessThan(20);
    for (let index = 1; index <= 4; index += 1) {
      expect(onchain.membersByGroupId.get(groupId(index))?.size).toBe(3);
    }
  });

  it("counts distinct wallets across eight membership removals in both scopes", () => {
    const { desired, config, onchain } = planFixture();
    const wallet = addr("1");
    for (let id = 1; id <= 8; id += 1) onchain.membersByGroupId.set(groupId(id), new Set([wallet]));

    const plan = buildReconciliationPlan({
      desired,
      config,
      onchain,
      batchSize: 100,
      addBudget: 100,
    });

    expect(plan.totalRemovals).toBe(8);
    expect(plan.removalWalletCount).toBe(1);
  });
});

describe("summarizeRemovalReasons", () => {
  it("separates blocked, demoted and no-longer-a-candidate removals", () => {
    const { desired, config, onchain } = planFixture();
    const blocked = addr("1");
    const demoted = addr("2");
    const gone = addr("3");
    const policy = desired.policies.get("historical-taker");
    policy?.membersByTier.PEASANT.add(demoted);

    onchain.membersByGroupId.set(groupId(1), new Set([blocked, demoted, gone]));
    onchain.membersByGroupId.set(groupId(2), new Set([blocked, demoted, gone]));

    const plan = buildReconciliationPlan({
      desired,
      config,
      onchain,
      batchSize: 100,
      addBudget: 100,
    });
    const reasons = summarizeRemovalReasons(plan, desired, (candidate) => candidate === blocked);

    expect(reasons).toEqual({ blocked: 2, demoted: 1, "not-a-candidate": 2 });
  });
});

describe("assertPlanSafe", () => {
  const limits = {
    maxPlannedAdds: 1_000,
    maxTotalRemovals: 10,
    maxRemovalWallets: 10,
    maxRemovalBpsPerGroup: 500,
  };

  function planFor(mutate: (fixture: ReturnType<typeof planFixture>) => void, addBudget = 1_000) {
    const fixture = planFixture();
    mutate(fixture);
    const plan = buildReconciliationPlan({ ...fixture, batchSize: 100, addBudget });
    const phase = selectPhase({
      deferredAdds: plan.deferredAdds,
      cascadeViolationCount: findCurrentCascadeViolations(fixture.config, fixture.onchain).length,
    });
    return { plan, phase };
  }

  it("requires an explicit initial-seed gate", () => {
    const { plan, phase } = planFor((fixture) => {
      fixture.desired.policies.get("historical-taker")?.membersByTier.PEASANT.add(addr("1"));
    });

    expect(() =>
      assertPlanSafe({
        plan,
        phase,
        allowInitialSeed: false,
        allowMigrationRemovals: false,
        ...limits,
      }),
    ).toThrow("ALLOW_INITIAL_SEED");
  });

  it("does not abort a real backfill run on pending removal-limit breaches", () => {
    const { plan, phase } = planFor((fixture) => {
      const policy = fixture.desired.policies.get("historical-taker");
      for (const digit of ["1", "2", "3", "4", "5"]) policy?.membersByTier.PEASANT.add(addr(digit));
      fixture.onchain.membersByGroupId.set(
        groupId(4),
        new Set([addr("6"), addr("7"), addr("8"), addr("9")]),
      );
    }, 2);

    expect(plan.deferredAdds).toBeGreaterThan(0);
    expect(phase).toBe("BACKFILL");
    expect(() =>
      assertPlanSafe({
        plan,
        phase,
        allowInitialSeed: true,
        allowMigrationRemovals: false,
        ...limits,
        maxTotalRemovals: 1,
        maxRemovalWallets: 1,
      }),
    ).not.toThrow();
  });

  it("enforces removal limits once removals can execute", () => {
    const { plan, phase } = planFor((fixture) => {
      fixture.onchain.membersByGroupId.set(
        groupId(1),
        new Set([addr("1"), addr("2"), addr("3"), addr("4")]),
      );
    });

    expect(phase).toBe("NORMAL");
    expect(() =>
      assertPlanSafe({
        plan,
        phase,
        allowInitialSeed: true,
        allowMigrationRemovals: false,
        ...limits,
        maxTotalRemovals: 1,
      }),
    ).toThrow("MAX_TOTAL_REMOVALS");
  });

  it("limits distinct wallets affected by removals", () => {
    const { plan, phase } = planFor((fixture) => {
      const wallet = addr("1");
      for (let id = 1; id <= 8; id += 1) {
        fixture.onchain.membersByGroupId.set(groupId(id), new Set([wallet]));
      }
    });

    expect(plan.totalRemovals).toBe(8);
    expect(() =>
      assertPlanSafe({
        plan,
        phase,
        allowInitialSeed: true,
        allowMigrationRemovals: false,
        ...limits,
        maxTotalRemovals: 100,
        maxRemovalWallets: 0,
        maxRemovalBpsPerGroup: 10_000,
      }),
    ).toThrow("MAX_REMOVAL_WALLETS");
  });

  it("rejects 101 PEASANT-only removals under the default global limit", () => {
    const { plan, phase } = planFor((fixture) => {
      const current = new Set(
        Array.from(
          { length: 101 },
          (_, index) => `0x${index.toString(16).padStart(40, "0")}` as Address,
        ),
      );
      fixture.onchain.membersByGroupId.set(groupId(1), current);
    });

    expect(() =>
      assertPlanSafe({
        plan,
        phase,
        allowInitialSeed: true,
        allowMigrationRemovals: false,
        ...limits,
        maxTotalRemovals: 100,
        maxRemovalWallets: 1_000,
        maxRemovalBpsPerGroup: 10_000,
      }),
    ).toThrow("MAX_TOTAL_REMOVALS");
  });

  it("gates a genuine migration repair behind an explicit approval", () => {
    const { plan, phase } = planFor((fixture) => {
      fixture.onchain.membersByGroupId.set(groupId(4), new Set([addr("1")]));
    });

    expect(phase).toBe("MIGRATION_REPAIR");
    expect(() =>
      assertPlanSafe({
        plan,
        phase,
        allowInitialSeed: true,
        allowMigrationRemovals: false,
        ...limits,
      }),
    ).toThrow("ALLOW_MIGRATION_REMOVALS");
  });

  it("rejects a plan above the planned-add ceiling", () => {
    const { plan, phase } = planFor((fixture) => {
      const policy = fixture.desired.policies.get("historical-taker");
      for (const digit of ["1", "2", "3"]) policy?.membersByTier.PEASANT.add(addr(digit));
    });

    expect(() =>
      assertPlanSafe({
        plan,
        phase,
        allowInitialSeed: true,
        allowMigrationRemovals: false,
        ...limits,
        maxPlannedAdds: 2,
      }),
    ).toThrow("MAX_PLANNED_ADDS");
  });
});

describe("assertDesiredSnapshotBounds", () => {
  it("rejects a desired count below minimumMembers", () => {
    const fixture = planFixture();
    const definition = fixture.config.groups[0];
    if (!definition) throw new Error("fixture missing group");
    definition.minimumMembers = 2;
    fixture.desired.policies.get("historical-taker")?.membersByTier.PEASANT.add(addr("1"));

    expect(() => assertDesiredSnapshotBounds(fixture.desired, fixture.config)).toThrow(
      "minimumMembers",
    );
  });

  it("rejects a desired count above maximumMembers", () => {
    const fixture = planFixture();
    const definition = fixture.config.groups[0];
    if (!definition) throw new Error("fixture missing group");
    definition.maximumMembers = 1;
    const policy = fixture.desired.policies.get("historical-taker");
    policy?.membersByTier.PEASANT.add(addr("1"));
    policy?.membersByTier.PEASANT.add(addr("2"));

    expect(() => assertDesiredSnapshotBounds(fixture.desired, fixture.config)).toThrow(
      "maximumMembers",
    );
  });

  it("rejects non-monotonic cumulative counts", () => {
    const fixture = planFixture();
    fixture.desired.policies.get("historical-taker")?.membersByTier.PEER.add(addr("3"));

    expect(() => assertDesiredSnapshotBounds(fixture.desired, fixture.config)).toThrow(
      "not monotonic",
    );
  });
});

describe("assertDesiredSnapshotComplete", () => {
  it("rejects a non-cascading desired snapshot", () => {
    const fixture = planFixture();
    fixture.desired.policies.get("historical-taker")?.membersByTier.PRO.add(addr("4"));

    expect(() => assertDesiredSnapshotComplete(fixture.desired, fixture.config)).toThrow(
      "not cascading",
    );
  });
});
