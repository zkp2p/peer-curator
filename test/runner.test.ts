import { describe, expect, it } from "vitest";
import { TIERS } from "../src/domain.js";
import { findCurrentCascadeViolations, mutationsForPhase, selectPhase } from "../src/phases.js";
import { buildReconciliationPlan } from "../src/reconcile.js";
import {
  assertPinnedIndexerSnapshot,
  IndexerSnapshotAdvancedError,
  runWithSnapshotRetries,
} from "../src/runner.js";
import { addr, applyMutations, groupId, planFixture } from "./fixtures.js";

describe("assertPinnedIndexerSnapshot", () => {
  it("accepts a stable, confirmed indexer watermark behind the RPC head", () => {
    expect(() =>
      assertPinnedIndexerSnapshot({
        snapshotBlock: 150n,
        finalIndexedBlock: 150n,
        rpcLatestBlock: 200n,
        confirmationBlocks: 20n,
      }),
    ).not.toThrow();
  });

  it("rejects an indexer watermark that changed while aggregate and membership rows were read", () => {
    expect(() =>
      assertPinnedIndexerSnapshot({
        snapshotBlock: 150n,
        finalIndexedBlock: 151n,
        rpcLatestBlock: 200n,
        confirmationBlocks: 20n,
      }),
    ).toThrow("Indexer advanced");
  });

  it("rejects a watermark that has not reached the configured confirmation depth", () => {
    expect(() =>
      assertPinnedIndexerSnapshot({
        snapshotBlock: 190n,
        finalIndexedBlock: 190n,
        rpcLatestBlock: 200n,
        confirmationBlocks: 20n,
      }),
    ).toThrow("not sufficiently confirmed");
  });
});

describe("runWithSnapshotRetries", () => {
  it("retries only the read-only snapshot race and then succeeds", async () => {
    let attempts = 0;
    const operation = async () => {
      attempts += 1;
      if (attempts < 3) throw new IndexerSnapshotAdvancedError();
    };
    const logger = {
      warn: () => undefined,
    };

    await runWithSnapshotRetries(
      {
        snapshotMaxAttempts: 3,
        snapshotRetryDelayMs: 0,
      } as never,
      logger as never,
      undefined,
      operation as never,
    );

    expect(attempts).toBe(3);
  });

  it("does not retry unrelated failures", async () => {
    let attempts = 0;
    const operation = async () => {
      attempts += 1;
      throw new Error("transaction failed");
    };

    await expect(
      runWithSnapshotRetries(
        {
          snapshotMaxAttempts: 10,
          snapshotRetryDelayMs: 0,
        } as never,
        { warn: () => undefined } as never,
        undefined,
        operation as never,
      ),
    ).rejects.toThrow("transaction failed");
    expect(attempts).toBe(1);
  });
});

describe("exclusive to cascading migration", () => {
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
});
