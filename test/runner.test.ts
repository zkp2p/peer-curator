import { describe, expect, it } from "vitest";
import { TIERS } from "../src/domain.js";
import { findCurrentCascadeViolations, mutationsForPhase, selectPhase } from "../src/phases.js";
import { buildReconciliationPlan } from "../src/reconcile.js";
import { assertPinnedIndexerSnapshot } from "../src/runner.js";
import { addr, applyMutations, groupId, planFixture } from "./fixtures.js";

describe("assertPinnedIndexerSnapshot", () => {
  it("accepts a stable, confirmed indexer watermark behind the RPC head", () => {
    expect(() =>
      assertPinnedIndexerSnapshot({
        snapshotBlock: 150n,
        rpcLatestBlock: 200n,
        confirmationBlocks: 20n,
      }),
    ).not.toThrow();
  });

  it("rejects a watermark that has not reached the configured confirmation depth", () => {
    expect(() =>
      assertPinnedIndexerSnapshot({
        snapshotBlock: 190n,
        rpcLatestBlock: 200n,
        confirmationBlocks: 20n,
      }),
    ).toThrow("not sufficiently confirmed");
  });
});

describe("exclusive to cascading migration", () => {
  function violationCount(fixture: ReturnType<typeof planFixture>): number {
    return findCurrentCascadeViolations(fixture.config, fixture.onchain).reduce(
      (total, violation) => total + violation.missingCount,
      0,
    );
  }

  function expectDesiredPrefix(
    fixture: ReturnType<typeof planFixture>,
    wallet: ReturnType<typeof addr>,
  ) {
    const policy = fixture.desired.policies.get("historical-taker");
    if (!policy) throw new Error("Missing historical-taker policy");

    for (let index = 0; index < TIERS.length; index += 1) {
      const tier = TIERS[index];
      if (!tier) throw new Error(`Tier missing at index ${index}`);
      expect(fixture.onchain.membersByGroupId.get(groupId(index + 1))?.has(wallet) ?? false).toBe(
        policy.membersByTier[tier].has(wallet),
      );
    }
  }

  function converge(fixture: ReturnType<typeof planFixture>): void {
    let runs = 0;
    while (runs < 5) {
      const plan = buildReconciliationPlan({
        ...fixture,
        batchSize: 1,
        addBudget: 100,
      });
      const phase = selectPhase({
        deferredAdds: plan.deferredAdds,
        cascadeViolationCount: findCurrentCascadeViolations(fixture.config, fixture.onchain).length,
      });
      const mutations = mutationsForPhase(plan, phase);
      if (mutations.length === 0) break;
      applyMutations(fixture.onchain, mutations);
      runs += 1;
    }
    expect(runs).toBeLessThan(5);
  }

  it("repairs a legacy PRO membership once backfill is complete", () => {
    const { desired, config, onchain } = planFixture();
    const wallet = addr("1");
    const policy = desired.policies.get("historical-taker");
    policy?.membersByTier.PEER.add(wallet);
    policy?.membersByTier.PEER.add(addr("2"));

    // Legacy exclusive state: PRO only.
    onchain.membersByGroupId.set(groupId(3), new Set([wallet]));

    // Run 1 — a budget of 1 leaves one PEER add deferred, so this is a genuine
    // BACKFILL. With a budget large enough to schedule both PEER adds, deferredAdds
    // would be 0 and the very first run would select MIGRATION_REPAIR instead.
    const backfill = buildReconciliationPlan({
      desired,
      config,
      onchain,
      batchSize: 100,
      addBudget: 1,
    });
    const backfillPhase = selectPhase({
      deferredAdds: backfill.deferredAdds,
      cascadeViolationCount: findCurrentCascadeViolations(config, onchain).length,
    });
    expect(backfill.deferredAdds).toBeGreaterThan(0);
    expect(backfillPhase).toBe("BACKFILL");
    applyMutations(onchain, mutationsForPhase(backfill, backfillPhase));

    // Run 2 — this is the spec's B2 case: totalAdds > 0 with deferredAdds == 0,
    // while PRO-without-PLUS still violates cascading.
    const repair = buildReconciliationPlan({
      desired,
      config,
      onchain,
      batchSize: 100,
      addBudget: 100,
    });
    const violations = findCurrentCascadeViolations(config, onchain);
    const repairPhase = selectPhase({
      deferredAdds: repair.deferredAdds,
      cascadeViolationCount: violations.length,
    });

    expect(repair.totalAdds).toBeGreaterThan(0);
    expect(repair.deferredAdds).toBe(0);
    expect(violations.length).toBeGreaterThan(0);
    expect(repairPhase).toBe("MIGRATION_REPAIR");

    const selected = mutationsForPhase(repair, repairPhase);
    const firstRemoval = selected.findIndex((mutation) => mutation.operation === "remove");
    const lastAdd = selected.map((mutation) => mutation.operation).lastIndexOf("add");
    expect(lastAdd).toBeGreaterThanOrEqual(0);
    expect(firstRemoval).toBeGreaterThanOrEqual(0);
    expect(lastAdd).toBeLessThan(firstRemoval);

    // Run 3 — after repair the state is cascading and the service returns to NORMAL.
    applyMutations(onchain, selected);
    const settled = buildReconciliationPlan({
      desired,
      config,
      onchain,
      batchSize: 100,
      addBudget: 100,
    });
    expect(findCurrentCascadeViolations(config, onchain)).toEqual([]);
    expect(selectPhase({ deferredAdds: settled.deferredAdds, cascadeViolationCount: 0 })).toBe(
      "NORMAL",
    );
  });

  it.each([
    ["PRO to PEER", 3, ["PEER"] as const],
    ["PLUS to PEER", 2, ["PEER"] as const],
  ])("converges an exclusive %s transition", (_label, legacyGroup, desiredTiers) => {
    const { desired, config, onchain } = planFixture();
    const wallet = addr("1");
    const policy = desired.policies.get("historical-taker");
    for (const tier of desiredTiers) policy?.membersByTier[tier].add(wallet);
    onchain.membersByGroupId.set(groupId(legacyGroup), new Set([wallet]));

    for (let run = 0; run < 5; run += 1) {
      const plan = buildReconciliationPlan({
        desired,
        config,
        onchain,
        batchSize: 100,
        addBudget: 100,
      });
      const phase = selectPhase({
        deferredAdds: plan.deferredAdds,
        cascadeViolationCount: findCurrentCascadeViolations(config, onchain).length,
      });
      applyMutations(onchain, mutationsForPhase(plan, phase));
    }

    expect(findCurrentCascadeViolations(config, onchain)).toEqual([]);
    const wanted: readonly string[] = desiredTiers;
    for (let id = 1; id <= 3; id += 1) {
      const tier = TIERS[id - 1];
      const expected = tier ? wanted.includes(tier) : false;
      expect(onchain.membersByGroupId.get(groupId(id))?.has(wallet) ?? false).toBe(expected);
    }
  });

  it.each([
    ["PRO to PEER", 3],
    ["PLUS to PEER", 2],
  ])(
    "keeps an interrupted %s migration non-worsening and convergent at every batch boundary",
    (_label, legacyGroup) => {
      for (let stopAfter = 0; stopAfter <= 2; stopAfter += 1) {
        const fixture = planFixture();
        const wallet = addr("1");
        fixture.desired.policies.get("historical-taker")?.membersByTier.PEER.add(wallet);
        fixture.onchain.membersByGroupId.set(groupId(legacyGroup), new Set([wallet]));

        const plan = buildReconciliationPlan({
          ...fixture,
          batchSize: 1,
          addBudget: 100,
        });
        const phase = selectPhase({
          deferredAdds: plan.deferredAdds,
          cascadeViolationCount: findCurrentCascadeViolations(fixture.config, fixture.onchain)
            .length,
        });
        expect(phase).toBe("MIGRATION_REPAIR");
        const selected = mutationsForPhase(plan, phase);
        expect(selected).toHaveLength(2);

        let appliedAddBatches = 0;
        let previousViolations = violationCount(fixture);
        for (const mutation of selected.slice(0, stopAfter)) {
          if (mutation.operation === "remove") {
            expect(appliedAddBatches).toBe(plan.addMutations.length);
          } else {
            appliedAddBatches += 1;
          }
          applyMutations(fixture.onchain, [mutation]);
          const currentViolations = violationCount(fixture);
          expect(currentViolations).toBeLessThanOrEqual(previousViolations);
          previousViolations = currentViolations;
        }

        converge(fixture);
        expect(violationCount(fixture)).toBe(0);
        expectDesiredPrefix(fixture, wallet);
      }
    },
  );

  it("leaves valid cascade prefixes at every NORMAL-phase batch boundary", () => {
    for (let stopAfter = 0; stopAfter <= 2; stopAfter += 1) {
      const fixture = planFixture();
      const wallet = addr("1");
      fixture.desired.policies.get("historical-taker")?.membersByTier.PEER.add(wallet);
      for (let id = 1; id <= 3; id += 1) {
        fixture.onchain.membersByGroupId.set(groupId(id), new Set([wallet]));
      }

      const plan = buildReconciliationPlan({
        ...fixture,
        batchSize: 1,
        addBudget: 100,
      });
      const phase = selectPhase({
        deferredAdds: plan.deferredAdds,
        cascadeViolationCount: findCurrentCascadeViolations(fixture.config, fixture.onchain).length,
      });
      expect(phase).toBe("NORMAL");
      const selected = mutationsForPhase(plan, phase);
      expect(selected).toHaveLength(2);
      expect(findCurrentCascadeViolations(fixture.config, fixture.onchain)).toEqual([]);

      for (const mutation of selected.slice(0, stopAfter)) {
        applyMutations(fixture.onchain, [mutation]);
        expect(findCurrentCascadeViolations(fixture.config, fixture.onchain)).toEqual([]);
      }
    }
  });
});
