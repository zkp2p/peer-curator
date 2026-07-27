import { describe, expect, it } from "vitest";
import { findCurrentCascadeViolations, mutationsForPhase, selectPhase } from "../src/phases.js";
import { addr, chainFixture, groupId } from "./fixtures.js";

describe("findCurrentCascadeViolations", () => {
  it("reports nothing for a cascading chain state", () => {
    const { config, onchain } = chainFixture();
    const wallet = addr("1");
    for (const id of [1, 2]) onchain.membersByGroupId.set(groupId(id), new Set([wallet]));
    expect(findCurrentCascadeViolations(config, onchain)).toEqual([]);
  });

  it("detects a legacy exclusive member present only in a high tier", () => {
    const { config, onchain } = chainFixture();
    onchain.membersByGroupId.set(groupId(3), new Set([addr("1")]));

    const violations = findCurrentCascadeViolations(config, onchain);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      scope: "historical-taker",
      higherTier: "PRO",
      lowerTier: "PLUS",
      missingCount: 1,
    });
  });
});

describe("selectPhase", () => {
  it("backfills while adds are deferred, regardless of cascade state", () => {
    expect(selectPhase({ deferredAdds: 5, cascadeViolationCount: 0 })).toBe("BACKFILL");
    expect(selectPhase({ deferredAdds: 5, cascadeViolationCount: 3 })).toBe("BACKFILL");
  });

  it("repairs once adds are complete but the chain is not cascading", () => {
    expect(selectPhase({ deferredAdds: 0, cascadeViolationCount: 1 })).toBe("MIGRATION_REPAIR");
  });

  it("reconciles normally once both conditions clear", () => {
    expect(selectPhase({ deferredAdds: 0, cascadeViolationCount: 0 })).toBe("NORMAL");
  });
});

describe("mutationsForPhase", () => {
  const plan = {
    groups: [],
    addMutations: [{ operation: "add" as const, groupId: groupId(1), members: [addr("1")] }],
    removalMutations: [{ operation: "remove" as const, groupId: groupId(3), members: [addr("2")] }],
    totalAdds: 1,
    totalRemovals: 1,
    deferredAdds: 0,
    removalWalletCount: 1,
    initialSeed: false,
  };

  it("omits removals during backfill", () => {
    expect(mutationsForPhase(plan, "BACKFILL")).toEqual(plan.addMutations);
  });

  it("runs adds before removals in repair and normal phases", () => {
    for (const phase of ["MIGRATION_REPAIR", "NORMAL"] as const) {
      expect(mutationsForPhase(plan, phase)).toEqual([
        ...plan.addMutations,
        ...plan.removalMutations,
      ]);
    }
  });
});
