# Cascading Tiers + Public PEASANT Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Review:** Internal self-review ✅ | Codex convergence ✅ (3 rounds)

**Goal:** Add a fourth public tier (PEASANT) across both policy scopes and convert the six exclusive `AddressGroupRegistry` groups into eight cascading ones, where each tier's group contains every higher tier's members.

**Architecture:** `TIERS` becomes an ordered ascending ladder whose order is load-bearing. `addMember` fills the whole `[PEASANT..T]` prefix instead of one set, so promotions become adds-only. Because the deployed state is exclusive and therefore not cascading, the reconciler derives a phase per run from the plan itself — add-only backfill, then gated migration repair, then normal reconciliation — rather than assuming the prefix invariant it needs.

**Tech Stack:** TypeScript 6 (ESM, `NodeNext`), zod 4 for config, viem 2 for chain access, vitest 4, biome for lint/format, pnpm 10.

**Source spec:** `docs/superpowers/specs/2026-07-27-peasant-tier-cascading-design.md`

## Global Constraints

- Node >= 22, pnpm 10.12.1. **`pnpm check` (lint + typecheck + test + build) must pass at every commit.** Each task below carries the consumer updates needed to keep that true — do not defer a broken call site to a later task.
- `tsconfig.json` sets `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. Indexed access into `TIERS` yields `Tier | undefined` and MUST be narrowed before use. Optional properties must be spread conditionally (`...(x ? { k: x } : {})`), never assigned `undefined`.
- No `any`. Use `unknown` if a type is genuinely unknown. For viem client stubs in tests, follow the repository's existing `as never` idiom (`test/onchain.test.ts:39`, `test/runner.test.ts:58`) — do not introduce `as any` or biome suppressions.
- Prefer self-documenting code over comments. Add JSDoc only to functions carrying non-obvious business logic.
- Never log member addresses or credentials. Counts and categories only.
- `TIERS` stays an `as const` array rather than a TS enum: ordering and iteration are load-bearing and the whole codebase is built on that pattern. This is a deliberate, spec-recorded exception to the usual enum preference.
- All eight groups are `isPublic == false` on-chain. "Public" in this project means publicly readable, never self-service. `assertRegistryGovernance` already rejects `isPublic == true` (`src/onchain.ts:96`) — do not weaken it.
- **Line numbers in this plan are baseline hints from the pre-change tree.** Earlier tasks shift them. Locate targets by symbol name and surrounding text, not by line number.
- Conventional commits: `<type>(<scope>): <subject>`, imperative, <= 50 chars, no period.

---

### Task 1: Tier ladder in the domain model

**Files:**
- Modify: `src/domain.ts` — `TIERS`, `emptyTierSets`, `tierCounts`, `tierForAddress`
- Modify: `test/policies.test.ts` — the one assertion that expects the old `PEASANT` sentinel
- Test: `test/domain.test.ts` (create)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `TIERS: readonly ["PEASANT","PEER","PLUS","PRO"]`, `type Tier = (typeof TIERS)[number]`
  - `NO_TIER = "NONE"`, `type TierOrNone = Tier | "NONE"`
  - `tierForAddress(snapshot: PolicySnapshot, address: Address): TierOrNone`
  - `assertCascadingSets(membersByTier: Record<Tier, Set<Address>>, label: string): void`

> `maximumMembers` deliberately lands in Task 3 alongside the config schema and every fixture that constructs a `GroupDefinition`. Adding it here would break `src/config.ts` and two `test/onchain.test.ts` literals with no schema to satisfy them.

- [ ] **Step 1: Write the failing tests**

Create `test/domain.test.ts`:

```ts
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  assertCascadingSets,
  emptyTierSets,
  normalizeAddress,
  type PolicySnapshot,
  tierCounts,
  tierForAddress,
  TIERS,
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/domain.test.ts`
Expected: FAIL — `assertCascadingSets` is not exported, and `TIERS` does not contain `PEASANT`.

- [ ] **Step 3: Update the tier ladder**

In `src/domain.ts`, replace the `TIERS` declaration and the `emptyTierSets` / `tierCounts` / `tierForAddress` bodies:

```ts
export const TIERS = ["PEASANT", "PEER", "PLUS", "PRO"] as const;
export type Tier = (typeof TIERS)[number];

export const NO_TIER = "NONE" as const;
export type TierOrNone = Tier | typeof NO_TIER;
```

```ts
export function emptyTierSets(): Record<Tier, Set<Address>> {
  return {
    PEASANT: new Set<Address>(),
    PEER: new Set<Address>(),
    PLUS: new Set<Address>(),
    PRO: new Set<Address>(),
  };
}
```

```ts
export function tierCounts(snapshot: PolicySnapshot): Record<Tier, number> {
  return {
    PEASANT: snapshot.membersByTier.PEASANT.size,
    PEER: snapshot.membersByTier.PEER.size,
    PLUS: snapshot.membersByTier.PLUS.size,
    PRO: snapshot.membersByTier.PRO.size,
  };
}
```

```ts
/**
 * Tier sets cascade, so a PRO member also appears in PLUS, PEER and PEASANT.
 * Iterating ascending would report PEASANT for every curated wallet, so this
 * walks the ladder downward and returns the highest tier actually held.
 */
export function tierForAddress(snapshot: PolicySnapshot, address: Address): TierOrNone {
  for (let index = TIERS.length - 1; index >= 0; index -= 1) {
    const tier = TIERS[index];
    if (tier && snapshot.membersByTier[tier].has(address)) return tier;
  }
  return NO_TIER;
}
```

- [ ] **Step 4: Add the shared cascade assertion**

Append to `src/domain.ts`:

```ts
/**
 * Tier membership is nested: every member of a tier must also belong to every
 * lower tier. Throws on the first violation so a malformed snapshot can never
 * reach the registry.
 */
export function assertCascadingSets(
  membersByTier: Record<Tier, Set<Address>>,
  label: string,
): void {
  for (let index = TIERS.length - 1; index > 0; index -= 1) {
    const higher = TIERS[index];
    const lower = TIERS[index - 1];
    if (!higher || !lower) continue;
    for (const address of membersByTier[higher]) {
      if (!membersByTier[lower].has(address)) {
        throw new Error(`${label} is not cascading: a ${higher} member is missing from ${lower}`);
      }
    }
  }
}
```

- [ ] **Step 5: Fix the two assertions this breaks**

`test/policies.test.ts` asserts `tierForAddress(snapshot, outsider)` is `"PEASANT"`. That sentinel is now `"NONE"`. Change that single expectation:

```ts
    expect(tierForAddress(snapshot, outsider)).toBe("NONE");
```

`test/reconcile.test.ts`'s "places all additions before removals and batches deterministically" test also breaks, because its fixture derives group IDs from `TIERS` — a fourth tier shifts `groupId(1)` from PEER to PEASANT, so populating `membersByTier.PEER` no longer lines up with the group the test seeds on-chain. Point the test at the floor tier so the arithmetic is restored:

```ts
    desired.policies.get("historical-taker")?.membersByTier.PEASANT.add(a);
    desired.policies.get("historical-taker")?.membersByTier.PEASANT.add(b);
    onchain.membersByGroupId.set(groupId(1), new Set([b, c]));
```

A lone PEASANT set is a valid cascade prefix, so this stays correct once Task 4 adds the cascade assertion. Leave the rest of both files alone — Tasks 2 and 5 rewrite them.

- [ ] **Step 6: Run the full check**

Run: `pnpm check`
Expected: PASS. `addMember` still early-returns on PEASANT, so tier sets remain exclusive and no other suite is affected.

- [ ] **Step 7: Commit**

```bash
git add src/domain.ts test/domain.test.ts test/policies.test.ts test/reconcile.test.ts
git commit -m "feat(domain): add PEASANT tier and cascading assertions"
```

---

### Task 2: Cascading policy calculation

**Files:**
- Modify: `src/policies.ts` — `ComputedMemberTier`, `addMember`, `assertExclusive` and its two call sites
- Test: `test/policies.test.ts`

**Interfaces:**
- Consumes: `TIERS`, `Tier`, `assertCascadingSets` from Task 1.
- Produces: `calculateHistoricalTakerPolicy` / `calculateCurrentEarnPolicy` return cascading `membersByTier`. `classifyTier` is unchanged.

- [ ] **Step 1: Rename the misleading describe block and update its tests**

The first describe in `test/policies.test.ts` is named `classifyTier` but its first test exercises `tierForAddress`. Split it: move that test into its own `describe("tierForAddress", ...)` and make the fixture cascading.

```ts
describe("tierForAddress", () => {
  it("returns the highest tier held and NONE for outsiders", () => {
    const peer = address("1");
    const outsider = address("2");
    const membersByTier = emptyTierSets();
    membersByTier.PEASANT.add(peer);
    membersByTier.PEER.add(peer);
    const snapshot = { scope: "historical-taker" as const, membersByTier, sourceRows: 1 };

    expect(tierForAddress(snapshot, peer)).toBe("PEER");
    expect(tierForAddress(snapshot, outsider)).toBe("NONE");
  });
});
```

The remaining `classifyTier` tests (threshold bands, lock-score demotion, dilution floor) are unchanged — `classifyTier` still returns the computed band including `TOP`.

- [ ] **Step 2: Update the policy assertions to expect cascading sets**

Replace the historical-taker assertions:

```ts
    expect(snapshot.membersByTier.PEASANT).toEqual(new Set([peer, pro]));
    expect(snapshot.membersByTier.PEER).toEqual(new Set([peer, pro]));
    expect(snapshot.membersByTier.PLUS).toEqual(new Set([pro]));
    expect(snapshot.membersByTier.PRO).toEqual(new Set([pro]));
```

Replace the current-earn assertions:

```ts
    expect(snapshot.membersByTier.PEASANT).toEqual(new Set([maker, peerPayOnly, topTier]));
    expect(snapshot.membersByTier.PEER).toEqual(new Set([maker, peerPayOnly, topTier]));
    expect(snapshot.membersByTier.PLUS).toEqual(new Set([maker, topTier]));
    expect(snapshot.membersByTier.PRO).toEqual(new Set([topTier]));
    expect(classifyTier(100_000_000_000n, 0n, 0n, CURRENT_EARN_POLICY)).toBe("TOP");
```

- [ ] **Step 3: Add the new cascading tests**

Append to the historical-taker describe block:

```ts
  it("places every classified wallet in PEASANT, including zero-volume rows", () => {
    const empty = address("8");
    const snapshot = calculateHistoricalTakerPolicy({
      takerStats: [{ id: `8453_${empty}`, owner: empty, totalFulfilledVolume: 0n, lockScore: 0n }],
      isBlockedWallet: () => false,
    });

    expect(snapshot.membersByTier.PEASANT).toEqual(new Set([empty]));
    expect(snapshot.membersByTier.PEER.size).toBe(0);
  });

  it("keeps a lock-score demoted wallet cascading at its reduced tier", () => {
    const demoted = address("9");
    const volume = 25_000_000_000n;
    const snapshot = calculateHistoricalTakerPolicy({
      takerStats: [
        {
          id: `8453_${demoted}`,
          owner: demoted,
          totalFulfilledVolume: volume,
          lockScore: volume * 200n,
        },
      ],
      isBlockedWallet: () => false,
    });

    expect(snapshot.membersByTier.PLUS).toEqual(new Set([demoted]));
    expect(snapshot.membersByTier.PEER).toEqual(new Set([demoted]));
    expect(snapshot.membersByTier.PEASANT).toEqual(new Set([demoted]));
    expect(snapshot.membersByTier.PRO.size).toBe(0);
  });

  it("excludes a blocked wallet from every tier including the PEASANT floor", () => {
    const blocked = address("a");
    const snapshot = calculateHistoricalTakerPolicy({
      takerStats: [
        { id: `8453_${blocked}`, owner: blocked, totalFulfilledVolume: 50_000_000_000n, lockScore: 0n },
      ],
      isBlockedWallet: (candidate) => candidate === blocked,
    });

    for (const tier of TIERS) expect(snapshot.membersByTier[tier].size).toBe(0);
  });
```

Add `TIERS` to the `../src/domain.js` import.

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm vitest run test/policies.test.ts`
Expected: FAIL — `membersByTier.PEASANT` is empty because `addMember` still early-returns.

- [ ] **Step 5: Make `addMember` fill the cascade prefix**

In `src/policies.ts`, replace `addMember`:

```ts
function addMember(snapshot: PolicySnapshot, tier: ComputedTier, address: Address): void {
  const publicTier: Tier = tier === "TOP" ? "PRO" : tier;
  const highestIndex = TIERS.indexOf(publicTier);
  for (let index = 0; index <= highestIndex; index += 1) {
    const cascadeTier = TIERS[index];
    if (cascadeTier) snapshot.membersByTier[cascadeTier].add(address);
  }
}
```

The `Math.max(0, ...)` clamp in `classifyTier` already guarantees the computed tier is never below `PEASANT`, so there is no early-return case left. Add `TIERS` to the existing `./domain.js` import.

- [ ] **Step 6: Replace the exclusivity assertion**

Delete `assertExclusive` and update both call sites (end of `calculateHistoricalTakerPolicy` and `calculateCurrentEarnPolicy`) to:

```ts
  assertCascadingSets(snapshot.membersByTier, snapshot.scope);
```

Import `assertCascadingSets` from `./domain.js`.

- [ ] **Step 7: Rename the threshold tier type**

Rename `ComputedMemberTier` to `ThresholdTier` (declaration and its use in `TierPolicy.thresholds`). `thresholds` only ever holds the four upper bands; PEASANT is the floor and deliberately has no threshold.

- [ ] **Step 8: Run the full check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/policies.ts test/policies.test.ts
git commit -m "feat(policies): calculate cascading tier membership"
```

---

### Task 3: Eight-group config with member bounds

**Files:**
- Modify: `src/domain.ts` — `GroupDefinition`
- Modify: `src/config.ts` — `groupFileSchema`, `readGroupsConfig`, env schema, `RuntimeSettings`, `loadSettings`
- Modify: `config/groups.example.json`, `.env.example`
- Modify: `test/onchain.test.ts` (two `GroupsConfig` literals), `test/reconcile.test.ts` (fixture)
- Test: `test/config.test.ts` (create)

**Interfaces:**
- Consumes: `TIERS` from Task 1.
- Produces:
  - `GroupDefinition` gains `maximumMembers: number`
  - `parseGroupsConfig(raw: string): GroupsConfig` (exported for testing)
  - `RuntimeSettings` gains `maxPlannedAdds`, `maxExecutedAddsPerRun`, `maxRemovalWallets`, `allowMigrationRemovals`; drops `maxTotalAdds`

- [ ] **Step 1: Write the failing tests**

Create `test/config.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/config.test.ts`
Expected: FAIL — `parseGroupsConfig` is not exported.

- [ ] **Step 3: Add `maximumMembers` to the group definition**

In `src/domain.ts`:

```ts
export interface GroupDefinition {
  scope: PolicyScope;
  tier: Tier;
  groupId: GroupId;
  minimumMembers: number;
  maximumMembers: number;
}
```

- [ ] **Step 4: Update the group file schema and export the parser**

In `src/config.ts`, replace `groupFileSchema`:

```ts
const groupFileSchema = z.object({
  chainId: z.literal(8453),
  registryAddress: z.string(),
  registryDeploymentBlock: z.string().regex(/^\d+$/),
  groups: z
    .array(
      z
        .object({
          scope: z.enum(POLICY_SCOPES),
          tier: z.enum(TIERS),
          groupId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
          minimumMembers: z.number().int().nonnegative(),
          maximumMembers: z.number().int().positive(),
        })
        .refine((group) => group.maximumMembers >= group.minimumMembers, {
          message: "maximumMembers must be greater than or equal to minimumMembers",
        }),
    )
    .length(8),
});
```

Split `readGroupsConfig` so the pure half is exported:

```ts
export function parseGroupsConfig(raw: string): GroupsConfig {
  const parsed = groupFileSchema.parse(JSON.parse(raw));
  const result: GroupsConfig = {
    chainId: parsed.chainId,
    registryAddress: normalizeAddress(parsed.registryAddress, "registryAddress"),
    registryDeploymentBlock: BigInt(parsed.registryDeploymentBlock),
    groups: parsed.groups.map((group) => ({
      scope: group.scope as PolicyScope,
      tier: group.tier as Tier,
      groupId: normalizeGroupId(group.groupId),
      minimumMembers: group.minimumMembers,
      maximumMembers: group.maximumMembers,
    })),
  };
  validateGroupCoverage(result);
  return result;
}

async function readGroupsConfig(
  inlineJson: string | undefined,
  path: string,
): Promise<GroupsConfig> {
  return parseGroupsConfig(inlineJson ?? (await readFile(path, "utf8")));
}
```

`validateGroupCoverage` needs no change — it already loops `POLICY_SCOPES x TIERS` and picks up PEASANT automatically, and it is the source of the "duplicate scope/tier" message.

- [ ] **Step 5: Update the env schema**

Replace `MAX_TOTAL_ADDS` and add the new keys:

```ts
  MAX_PLANNED_ADDS: nonNegativeInteger("25000"),
  MAX_EXECUTED_ADDS_PER_RUN: positiveInteger("3000"),
  MAX_TOTAL_REMOVALS: nonNegativeInteger("100"),
  MAX_REMOVAL_WALLETS: nonNegativeInteger("50"),
  ALLOW_MIGRATION_REMOVALS: booleanFromString,
```

In `RuntimeSettings` replace `maxTotalAdds: number` with:

```ts
  maxPlannedAdds: number;
  maxExecutedAddsPerRun: number;
  maxRemovalWallets: number;
  allowMigrationRemovals: boolean;
```

In the `loadSettings` return, replace `maxTotalAdds: env.MAX_TOTAL_ADDS` with:

```ts
    maxPlannedAdds: env.MAX_PLANNED_ADDS,
    maxExecutedAddsPerRun: env.MAX_EXECUTED_ADDS_PER_RUN,
    maxRemovalWallets: env.MAX_REMOVAL_WALLETS,
    allowMigrationRemovals: env.ALLOW_MIGRATION_REMOVALS,
```

- [ ] **Step 6: Fix every existing `GroupDefinition` literal**

`maximumMembers` is required, so all three existing fixtures break. Add `maximumMembers: 1_000_000` to:
- `test/onchain.test.ts` — the group literal inside the first `GroupsConfig` (near `minimumMembers: 0`)
- `test/onchain.test.ts` — the group literal inside the second `GroupsConfig`
- `test/reconcile.test.ts` — the `fixtures()` group mapping

For `test/reconcile.test.ts` the mapping becomes:

```ts
  const groups = POLICY_SCOPES.flatMap((scope, scopeIndex) =>
    TIERS.map((tier, tierIndex) => ({
      scope,
      tier,
      groupId: groupId(scopeIndex * TIERS.length + tierIndex + 1),
      minimumMembers: 0,
      maximumMembers: 1_000_000,
    })),
  );
```

- [ ] **Step 7: Update `config/groups.example.json`**

Placeholder group IDs 1-8 in `TIERS` order per scope, bounds from the 2026-07-27 production measurement (minimum ~80%, maximum ~150%):

```json
{
  "chainId": 8453,
  "registryAddress": "0x0000000000000000000000000000000000000000",
  "registryDeploymentBlock": "0",
  "groups": [
    { "scope": "historical-taker", "tier": "PEASANT", "groupId": "0x0000000000000000000000000000000000000000000000000000000000000001", "minimumMembers": 8000, "maximumMembers": 15000 },
    { "scope": "historical-taker", "tier": "PEER", "groupId": "0x0000000000000000000000000000000000000000000000000000000000000002", "minimumMembers": 1350, "maximumMembers": 2600 },
    { "scope": "historical-taker", "tier": "PLUS", "groupId": "0x0000000000000000000000000000000000000000000000000000000000000003", "minimumMembers": 680, "maximumMembers": 1300 },
    { "scope": "historical-taker", "tier": "PRO", "groupId": "0x0000000000000000000000000000000000000000000000000000000000000004", "minimumMembers": 165, "maximumMembers": 320 },
    { "scope": "current-earn", "tier": "PEASANT", "groupId": "0x0000000000000000000000000000000000000000000000000000000000000005", "minimumMembers": 1400, "maximumMembers": 2700 },
    { "scope": "current-earn", "tier": "PEER", "groupId": "0x0000000000000000000000000000000000000000000000000000000000000006", "minimumMembers": 500, "maximumMembers": 960 },
    { "scope": "current-earn", "tier": "PLUS", "groupId": "0x0000000000000000000000000000000000000000000000000000000000000007", "minimumMembers": 175, "maximumMembers": 330 },
    { "scope": "current-earn", "tier": "PRO", "groupId": "0x0000000000000000000000000000000000000000000000000000000000000008", "minimumMembers": 50, "maximumMembers": 100 }
  ]
}
```

- [ ] **Step 8: Update `.env.example`**

Replace the `MAX_TOTAL_ADDS=3000` line with:

```text
MAX_PLANNED_ADDS=25000
MAX_EXECUTED_ADDS_PER_RUN=3000
MAX_TOTAL_REMOVALS=100
MAX_REMOVAL_WALLETS=50
ALLOW_MIGRATION_REMOVALS=false
```

Leave `MAX_REMOVAL_BPS_PER_GROUP=500` as-is.

> `src/runner.ts` still passes `maxTotalAdds: settings.maxTotalAdds` to `assertPlanSafe`. Change that one line to `maxTotalAdds: settings.maxPlannedAdds` so the tree compiles; Task 7 renames the parameter itself.

- [ ] **Step 9: Run the full check**

Run: `pnpm check`
Expected: PASS (4 new config tests).

- [ ] **Step 10: Commit**

```bash
git add src/domain.ts src/config.ts src/runner.ts config/groups.example.json .env.example test/config.test.ts test/onchain.test.ts test/reconcile.test.ts
git commit -m "feat(config): require eight cascading groups with bounds"
```

---

### Task 4: State-free desired-snapshot validation

**Files:**
- Modify: `src/reconcile.ts` — `assertDesiredSnapshotComplete`, `assertPlanSafe`
- Test: `test/reconcile.test.ts`

**Interfaces:**
- Consumes: `assertCascadingSets`, `tierCounts`, `GroupDefinition.maximumMembers`.
- Produces: `assertDesiredSnapshotBounds(desired: DesiredSnapshot, config: GroupsConfig): void`. `assertDesiredSnapshotComplete` keeps its signature.

- [ ] **Step 1: Write the failing tests**

Append to `test/reconcile.test.ts`:

```ts
describe("assertDesiredSnapshotBounds", () => {
  it("rejects a desired count below minimumMembers", () => {
    const fixture = fixtures();
    const definition = fixture.config.groups[0];
    if (!definition) throw new Error("fixture missing group");
    definition.minimumMembers = 2;
    fixture.desired.policies.get("historical-taker")?.membersByTier.PEASANT.add(addr("1"));

    expect(() => assertDesiredSnapshotBounds(fixture.desired, fixture.config)).toThrow(
      "minimumMembers",
    );
  });

  it("rejects a desired count above maximumMembers", () => {
    const fixture = fixtures();
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
    const fixture = fixtures();
    fixture.desired.policies.get("historical-taker")?.membersByTier.PEER.add(addr("3"));

    expect(() => assertDesiredSnapshotBounds(fixture.desired, fixture.config)).toThrow(
      "not monotonic",
    );
  });
});

describe("assertDesiredSnapshotComplete", () => {
  it("rejects a non-cascading desired snapshot", () => {
    const fixture = fixtures();
    fixture.desired.policies.get("historical-taker")?.membersByTier.PRO.add(addr("4"));

    expect(() => assertDesiredSnapshotComplete(fixture.desired, fixture.config)).toThrow(
      "not cascading",
    );
  });
});
```

Add both functions to the `../src/reconcile.js` import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/reconcile.test.ts`
Expected: FAIL — `assertDesiredSnapshotBounds` is not exported.

- [ ] **Step 3: Replace the duplicate scan with the cascade assertion**

Replace the body of `assertDesiredSnapshotComplete`:

```ts
export function assertDesiredSnapshotComplete(
  desired: DesiredSnapshot,
  config: GroupsConfig,
): void {
  for (const scope of POLICY_SCOPES) {
    const policy = desired.policies.get(scope);
    if (!policy) throw new Error(`Missing policy snapshot ${scope}`);
    assertCascadingSets(policy.membersByTier, scope);

    for (const tier of TIERS) {
      if (
        !config.groups.some((group) => groupKey(group.scope, group.tier) === groupKey(scope, tier))
      ) {
        throw new Error(`Missing configured group for ${scope}:${tier}`);
      }
    }
  }
}
```

- [ ] **Step 4: Add the state-free bounds check**

Append to `src/reconcile.ts`:

```ts
/**
 * Validates the calculated snapshot without reference to on-chain state, so a
 * bad calculation is caught even when the resulting diff happens to be small.
 * The monotonicity check is deliberately redundant with assertCascadingSets —
 * it is a cheap independent cross-check on the same invariant.
 */
export function assertDesiredSnapshotBounds(
  desired: DesiredSnapshot,
  config: GroupsConfig,
): void {
  for (const scope of POLICY_SCOPES) {
    const policy = desired.policies.get(scope);
    if (!policy) throw new Error(`Missing policy snapshot ${scope}`);
    const counts = tierCounts(policy);

    for (const definition of config.groups.filter((group) => group.scope === scope)) {
      const count = counts[definition.tier];
      if (count < definition.minimumMembers) {
        throw new Error(
          `${scope}:${definition.tier} desired count ${count} is below minimumMembers ${definition.minimumMembers}`,
        );
      }
      if (count > definition.maximumMembers) {
        throw new Error(
          `${scope}:${definition.tier} desired count ${count} exceeds maximumMembers ${definition.maximumMembers}`,
        );
      }
    }

    for (let index = TIERS.length - 1; index > 0; index -= 1) {
      const higher = TIERS[index];
      const lower = TIERS[index - 1];
      if (!higher || !lower) continue;
      if (counts[higher] > counts[lower]) {
        throw new Error(
          `${scope} tier counts are not monotonic: ${higher} ${counts[higher]} exceeds ${lower} ${counts[lower]}`,
        );
      }
    }
  }
}
```

Import `assertCascadingSets` and `tierCounts` from `./domain.js`.

- [ ] **Step 5: Remove the minimumMembers check from `assertPlanSafe`**

Delete the `group.desiredCount < group.definition.minimumMembers` block from `assertPlanSafe` — it now lives in `assertDesiredSnapshotBounds`. Delete the now-duplicated "enforces minimum expected group size" test from `test/reconcile.test.ts`.

- [ ] **Step 6: Run the full check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/reconcile.ts test/reconcile.test.ts
git commit -m "feat(reconcile): validate desired snapshot without chain state"
```

---

### Task 5: Tier-ordered mutations, truncation, and removal reasons

**Files:**
- Create: `test/fixtures.ts`
- Modify: `src/reconcile.ts` — `GroupPlan`, `ReconciliationPlan`, `buildReconciliationPlan`
- Modify: `src/runner.ts` — the `buildReconciliationPlan` call and the `plan.mutations` references
- Test: `test/reconcile.test.ts`

**Interfaces:**
- Consumes: `TIERS`, `GroupMutation`.
- Produces:
  - `GroupPlan` gains `deferredAdds: number`
  - `ReconciliationPlan` replaces `mutations` with `addMutations` + `removalMutations`, and gains `deferredAdds`, `removalWalletCount`
  - `buildReconciliationPlan` gains a required `addBudget: number`
  - `REMOVAL_REASONS`, `type RemovalReason`, `summarizeRemovalReasons(plan, desired, isBlockedWallet): Record<RemovalReason, number>`
  - `test/fixtures.ts` exports `addr`, `groupId`, `chainFixture`, `planFixture`, `applyMutations`

- [ ] **Step 1: Create the shared test fixtures**

Tasks 5, 6 and 8 all need these. Create `test/fixtures.ts`:

```ts
import type { Address } from "viem";
import {
  type DesiredSnapshot,
  emptyTierSets,
  type GroupsConfig,
  normalizeAddress,
  normalizeGroupId,
  POLICY_SCOPES,
  TIERS,
} from "../src/domain.js";
import type { GroupMutation, RegistryState } from "../src/onchain.js";

export const addr = (digit: string): Address => normalizeAddress(`0x${digit.repeat(40)}`);
export const groupId = (value: number) =>
  normalizeGroupId(`0x${value.toString(16).padStart(64, "0")}`);

/**
 * Eight empty groups in TIERS order per scope, so groupId(1..4) is
 * historical-taker PEASANT/PEER/PLUS/PRO and groupId(5..8) is current-earn.
 */
export function chainFixture(): { config: GroupsConfig; onchain: RegistryState } {
  const groups = POLICY_SCOPES.flatMap((scope, scopeIndex) =>
    TIERS.map((tier, tierIndex) => ({
      scope,
      tier,
      groupId: groupId(scopeIndex * TIERS.length + tierIndex + 1),
      minimumMembers: 0,
      maximumMembers: 1_000_000,
    })),
  );
  return {
    config: {
      chainId: 8453,
      registryAddress: addr("f"),
      registryDeploymentBlock: 1n,
      groups,
    },
    onchain: {
      membersByGroupId: new Map(groups.map((group) => [group.groupId, new Set<Address>()])),
      governanceByGroupId: new Map(),
      snapshotBlock: 100n,
      indexedThroughBlock: 100n,
    },
  };
}

export function planFixture(): {
  desired: DesiredSnapshot;
  config: GroupsConfig;
  onchain: RegistryState;
} {
  const policies = new Map();
  for (const scope of POLICY_SCOPES) {
    policies.set(scope, { scope, membersByTier: emptyTierSets(), sourceRows: 1 });
  }
  return {
    desired: { policies, blockedWalletCount: 0, calculatedAt: "2026-07-27T00:00:00.000Z" },
    ...chainFixture(),
  };
}

/** Applies mutations to the fixture's chain state so multi-run convergence can be simulated. */
export function applyMutations(onchain: RegistryState, mutations: GroupMutation[]): void {
  for (const mutation of mutations) {
    const members = onchain.membersByGroupId.get(mutation.groupId);
    if (!members) throw new Error(`Unknown group ${mutation.groupId}`);
    for (const member of mutation.members) {
      if (mutation.operation === "add") members.add(member);
      else members.delete(member);
    }
  }
}
```

Refactor `test/reconcile.test.ts` to import `addr`, `groupId`, `planFixture` and `applyMutations` from `./fixtures.js`, deleting its local `addr` / `groupId` / `fixtures` helpers. Rename its call sites from `fixtures()` to `planFixture()`.

- [ ] **Step 2: Write the failing tests**

Replace the `buildReconciliationPlan` describe block:

```ts
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

    const plan = buildReconciliationPlan({ desired, config, onchain, batchSize: 100, addBudget: 100 });
    const tierOf = (mutation: { groupId: string }) =>
      config.groups.find((group) => group.groupId === mutation.groupId)?.tier;

    expect(plan.addMutations.map(tierOf)).toEqual(["PEASANT", "PEER"]);
    expect(plan.removalMutations.map(tierOf)).toEqual(["PRO", "PLUS"]);
  });

  it("truncates adds at the budget and reports the deferred remainder", () => {
    const { desired, config, onchain } = planFixture();
    const policy = desired.policies.get("historical-taker");
    for (const digit of ["1", "2", "3"]) policy?.membersByTier.PEASANT.add(addr(digit));

    const plan = buildReconciliationPlan({ desired, config, onchain, batchSize: 100, addBudget: 2 });

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

      const plan = buildReconciliationPlan({ desired, config, onchain, batchSize: 100, addBudget: budget });
      applyMutations(onchain, plan.addMutations);

      const held = TIERS.map((_, index) =>
        onchain.membersByGroupId.get(groupId(index + 1))?.has(wallet) ?? false,
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

    const plan = buildReconciliationPlan({ desired, config, onchain, batchSize: 100, addBudget: 100 });

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

    const plan = buildReconciliationPlan({ desired, config, onchain, batchSize: 100, addBudget: 100 });
    const reasons = summarizeRemovalReasons(plan, desired, (candidate) => candidate === blocked);

    expect(reasons).toEqual({ blocked: 2, demoted: 1, "not-a-candidate": 2 });
  });
});
```

Add `TIERS` and `summarizeRemovalReasons` to the imports.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run test/reconcile.test.ts -t buildReconciliationPlan`
Expected: FAIL — `addBudget` is not accepted and `addMutations` does not exist.

- [ ] **Step 4: Update the plan types**

```ts
export interface GroupPlan {
  definition: GroupDefinition;
  currentCount: number;
  desiredCount: number;
  additions: Address[];
  removals: Address[];
  deferredAdds: number;
}

/**
 * `additions`, `removals`, `totalAdds` and `totalRemovals` describe the FULL
 * pre-truncation plan and are what validation reasons about. `addMutations` is
 * post-truncation — only what this run will execute.
 */
export interface ReconciliationPlan {
  groups: GroupPlan[];
  addMutations: GroupMutation[];
  removalMutations: GroupMutation[];
  totalAdds: number;
  totalRemovals: number;
  deferredAdds: number;
  removalWalletCount: number;
  initialSeed: boolean;
}
```

- [ ] **Step 5: Rewrite the plan builder**

```ts
export function buildReconciliationPlan(input: {
  desired: DesiredSnapshot;
  config: GroupsConfig;
  onchain: RegistryState;
  batchSize: number;
  addBudget: number;
}): ReconciliationPlan {
  const groups = input.config.groups.map((definition): GroupPlan => {
    const current = input.onchain.membersByGroupId.get(definition.groupId);
    if (!current) throw new Error(`Missing on-chain state for group ${definition.groupId}`);
    const desired = getDesiredMembers(input.desired, definition);
    return {
      definition,
      currentCount: current.size,
      desiredCount: desired.size,
      additions: sortedDifference(desired, current),
      removals: sortedDifference(current, desired),
      deferredAdds: 0,
    };
  });

  const tierRank = (plan: GroupPlan) => TIERS.indexOf(plan.definition.tier);
  const ascending = [...groups].sort((left, right) => tierRank(left) - tierRank(right));
  const descending = [...groups].sort((left, right) => tierRank(right) - tierRank(left));

  let remainingBudget = Math.max(0, input.addBudget);
  const addMutations: GroupMutation[] = [];
  for (const group of ascending) {
    const scheduled = group.additions.slice(0, remainingBudget);
    group.deferredAdds = group.additions.length - scheduled.length;
    remainingBudget -= scheduled.length;
    for (const members of chunks(scheduled, input.batchSize)) {
      addMutations.push({ operation: "add", groupId: group.definition.groupId, members });
    }
  }

  const removalMutations = descending.flatMap((group) =>
    chunks(group.removals, input.batchSize).map(
      (members): GroupMutation => ({
        operation: "remove",
        groupId: group.definition.groupId,
        members,
      }),
    ),
  );

  const removalWallets = new Set<Address>();
  for (const group of groups) {
    for (const address of group.removals) removalWallets.add(address);
  }

  return {
    groups,
    addMutations,
    removalMutations,
    totalAdds: groups.reduce((total, group) => total + group.additions.length, 0),
    totalRemovals: groups.reduce((total, group) => total + group.removals.length, 0),
    deferredAdds: groups.reduce((total, group) => total + group.deferredAdds, 0),
    removalWalletCount: removalWallets.size,
    initialSeed: groups.every((group) => group.currentCount === 0),
  };
}
```

Import `TIERS` from `./domain.js`.

- [ ] **Step 6: Add removal reason classification**

The migration approval gate needs to know *why* each removal is happening, without logging addresses. Append to `src/reconcile.ts`:

```ts
export const REMOVAL_REASONS = ["blocked", "demoted", "not-a-candidate"] as const;
export type RemovalReason = (typeof REMOVAL_REASONS)[number];

/**
 * Categorises planned removals for the migration approval report. "demoted"
 * means the wallet is still curated in this scope but at a lower tier;
 * "not-a-candidate" covers wallets that left the source set entirely, which
 * includes legacy and manually-added registry memberships.
 */
export function summarizeRemovalReasons(
  plan: ReconciliationPlan,
  desired: DesiredSnapshot,
  isBlocked: (address: Address) => boolean,
): Record<RemovalReason, number> {
  const totals: Record<RemovalReason, number> = {
    blocked: 0,
    demoted: 0,
    "not-a-candidate": 0,
  };

  for (const group of plan.groups) {
    const policy = desired.policies.get(group.definition.scope);
    if (!policy) throw new Error(`Missing desired policy ${group.definition.scope}`);
    for (const address of group.removals) {
      if (isBlocked(address)) {
        totals.blocked += 1;
      } else if (TIERS.some((tier) => policy.membersByTier[tier].has(address))) {
        totals.demoted += 1;
      } else {
        totals["not-a-candidate"] += 1;
      }
    }
  }

  return totals;
}
```

- [ ] **Step 7: Keep the runner compiling**

`src/runner.ts` references `plan.mutations` in its log line, its early return, and its `executeMutations` call. Replace all three with a local composed list, preserving today's adds-before-removals behaviour until Task 8 introduces phases:

```ts
  const mutations = [...plan.addMutations, ...plan.removalMutations];
```

and pass `addBudget: settings.maxExecutedAddsPerRun` to `buildReconciliationPlan`.

- [ ] **Step 8: Run the full check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/reconcile.ts src/runner.ts test/fixtures.ts test/reconcile.test.ts
git commit -m "feat(reconcile): order mutations by tier and budget adds"
```

---

### Task 6: Derived phase selection

**Files:**
- Create: `src/phases.ts`
- Test: `test/phases.test.ts` (create)

**Interfaces:**
- Consumes: `chainFixture` from Task 5, `ReconciliationPlan` from Task 5.
- Produces:
  - `RECONCILIATION_PHASES = ["BACKFILL","MIGRATION_REPAIR","NORMAL"]`, `type ReconciliationPhase`
  - `findCurrentCascadeViolations(config, onchain): CascadeViolation[]`
  - `selectPhase(input: { deferredAdds: number; cascadeViolationCount: number }): ReconciliationPhase`
  - `mutationsForPhase(plan, phase): GroupMutation[]`

- [ ] **Step 1: Write the failing tests**

Create `test/phases.test.ts`:

```ts
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
    onchain.membersByGroupId.set(groupId(4), new Set([addr("1")]));

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
    removalMutations: [{ operation: "remove" as const, groupId: groupId(4), members: [addr("2")] }],
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/phases.test.ts`
Expected: FAIL — `src/phases.ts` does not exist.

- [ ] **Step 3: Create `src/phases.ts`**

```ts
import {
  type GroupsConfig,
  groupKey,
  type PolicyScope,
  POLICY_SCOPES,
  type Tier,
  TIERS,
} from "./domain.js";
import type { GroupMutation, RegistryState } from "./onchain.js";
import type { ReconciliationPlan } from "./reconcile.js";

export const RECONCILIATION_PHASES = ["BACKFILL", "MIGRATION_REPAIR", "NORMAL"] as const;
export type ReconciliationPhase = (typeof RECONCILIATION_PHASES)[number];

export interface CascadeViolation {
  scope: PolicyScope;
  higherTier: Tier;
  lowerTier: Tier;
  missingCount: number;
}

/**
 * Counts curated members that sit in a tier without belonging to the tier below.
 * The deployed groups are exclusive, so violations are expected until migration
 * completes; the count drives phase selection rather than throwing.
 */
export function findCurrentCascadeViolations(
  config: GroupsConfig,
  onchain: RegistryState,
): CascadeViolation[] {
  const idByKey = new Map(
    config.groups.map((group) => [groupKey(group.scope, group.tier), group.groupId]),
  );
  const violations: CascadeViolation[] = [];

  for (const scope of POLICY_SCOPES) {
    for (let index = TIERS.length - 1; index > 0; index -= 1) {
      const higherTier = TIERS[index];
      const lowerTier = TIERS[index - 1];
      if (!higherTier || !lowerTier) continue;

      const higherId = idByKey.get(groupKey(scope, higherTier));
      const lowerId = idByKey.get(groupKey(scope, lowerTier));
      if (!higherId || !lowerId) throw new Error(`Missing configured group for ${scope}`);

      const higher = onchain.membersByGroupId.get(higherId);
      const lower = onchain.membersByGroupId.get(lowerId);
      if (!higher || !lower) throw new Error(`Missing on-chain membership for ${scope}`);

      let missingCount = 0;
      for (const member of higher) {
        if (!lower.has(member)) missingCount += 1;
      }
      if (missingCount > 0) violations.push({ scope, higherTier, lowerTier, missingCount });
    }
  }

  return violations;
}

/**
 * Phase is derived from the plan, never from operator state or group emptiness.
 * A model that forbade removals whenever the cascade check failed would
 * deadlock: legacy high-tier memberships are only repairable by removal.
 */
export function selectPhase(input: {
  deferredAdds: number;
  cascadeViolationCount: number;
}): ReconciliationPhase {
  if (input.deferredAdds > 0) return "BACKFILL";
  if (input.cascadeViolationCount > 0) return "MIGRATION_REPAIR";
  return "NORMAL";
}

export function mutationsForPhase(
  plan: ReconciliationPlan,
  phase: ReconciliationPhase,
): GroupMutation[] {
  if (phase === "BACKFILL") return plan.addMutations;
  return [...plan.addMutations, ...plan.removalMutations];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/phases.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Run the full check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/phases.ts test/phases.test.ts
git commit -m "feat(phases): derive reconciliation phase from the plan"
```

---

### Task 7: Phase-aware safety limits

**Files:**
- Modify: `src/reconcile.ts` — `assertPlanSafe`
- Modify: `src/runner.ts` — the `assertPlanSafe` call
- Test: `test/reconcile.test.ts`

**Interfaces:**
- Consumes: `ReconciliationPhase` from Task 6.
- Produces: `assertPlanSafe(input: { plan, phase, allowInitialSeed, allowMigrationRemovals, maxPlannedAdds, maxTotalRemovals, maxRemovalWallets, maxRemovalBpsPerGroup }): void`

- [ ] **Step 1: Write the failing tests**

Every test derives its phase from `selectPhase` rather than asserting a hand-picked one, so an unreachable phase/plan combination cannot pass. Replace the `assertPlanSafe` describe block:

```ts
describe("assertPlanSafe", () => {
  const limits = {
    maxPlannedAdds: 1_000,
    maxTotalRemovals: 10,
    maxRemovalWallets: 10,
    maxRemovalBpsPerGroup: 500,
  };

  function planFor(
    mutate: (fixture: ReturnType<typeof planFixture>) => void,
    addBudget = 1_000,
  ) {
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
      assertPlanSafe({ plan, phase, allowInitialSeed: false, allowMigrationRemovals: false, ...limits }),
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
      assertPlanSafe({ plan, phase, allowInitialSeed: true, allowMigrationRemovals: false, ...limits }),
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
```

Add `selectPhase` and `findCurrentCascadeViolations` to the imports from `../src/phases.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/reconcile.test.ts -t assertPlanSafe`
Expected: FAIL — `assertPlanSafe` does not accept `phase`.

- [ ] **Step 3: Rewrite `assertPlanSafe`**

```ts
export function assertPlanSafe(input: {
  plan: ReconciliationPlan;
  phase: ReconciliationPhase;
  allowInitialSeed: boolean;
  allowMigrationRemovals: boolean;
  maxPlannedAdds: number;
  maxTotalRemovals: number;
  maxRemovalWallets: number;
  maxRemovalBpsPerGroup: number;
}): void {
  if (input.plan.initialSeed && !input.allowInitialSeed && input.plan.totalAdds > 0) {
    throw new Error("Initial seed requires ALLOW_INITIAL_SEED=true");
  }
  if (input.plan.totalAdds > input.maxPlannedAdds) {
    throw new Error(
      `Planned additions ${input.plan.totalAdds} exceed MAX_PLANNED_ADDS ${input.maxPlannedAdds}`,
    );
  }

  if (input.phase === "BACKFILL") return;

  if (input.phase === "MIGRATION_REPAIR" && !input.allowMigrationRemovals) {
    throw new Error("Migration repair requires ALLOW_MIGRATION_REMOVALS=true");
  }
  if (input.plan.totalRemovals > input.maxTotalRemovals) {
    throw new Error(
      `Planned removals ${input.plan.totalRemovals} exceed MAX_TOTAL_REMOVALS ${input.maxTotalRemovals}`,
    );
  }
  if (input.plan.removalWalletCount > input.maxRemovalWallets) {
    throw new Error(
      `Removals affect ${input.plan.removalWalletCount} wallets, exceeding MAX_REMOVAL_WALLETS ${input.maxRemovalWallets}`,
    );
  }

  for (const group of input.plan.groups) {
    if (group.currentCount === 0 || group.removals.length === 0) continue;
    const removalBps = Math.ceil((group.removals.length * 10_000) / group.currentCount);
    if (removalBps > input.maxRemovalBpsPerGroup) {
      throw new Error(
        `${group.definition.scope}:${group.definition.tier} removal rate ${removalBps} bps exceeds limit ${input.maxRemovalBpsPerGroup}`,
      );
    }
  }
}
```

Add `import type { ReconciliationPhase } from "./phases.js";`.

> `src/phases.ts` imports `ReconciliationPlan` from `./reconcile.js` and `src/reconcile.ts` imports `ReconciliationPhase` from `./phases.js`. Both must use `import type` so no runtime import is emitted and the cycle stays type-only.

- [ ] **Step 4: Keep the runner compiling**

Update the `assertPlanSafe` call in `src/runner.ts` to the new shape. Phase wiring lands in Task 8, so pass a derived phase now rather than a placeholder:

```ts
  const phase = selectPhase({
    deferredAdds: plan.deferredAdds,
    cascadeViolationCount: findCurrentCascadeViolations(groups, onchain).length,
  });
  assertPlanSafe({
    plan,
    phase,
    allowInitialSeed: settings.allowInitialSeed,
    allowMigrationRemovals: settings.allowMigrationRemovals,
    maxPlannedAdds: settings.maxPlannedAdds,
    maxTotalRemovals: settings.maxTotalRemovals,
    maxRemovalWallets: settings.maxRemovalWallets,
    maxRemovalBpsPerGroup: settings.maxRemovalBpsPerGroup,
  });
```

- [ ] **Step 5: Run the full check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/reconcile.ts src/runner.ts test/reconcile.test.ts
git commit -m "feat(reconcile): scope destructive limits to executing phases"
```

---

### Task 8: Execution wiring, per-transaction logging, and migration regressions

**Files:**
- Modify: `src/onchain.ts` — `executeMutations`
- Modify: `src/runner.ts` — logging, `mutationsForPhase`, removal reason report
- Test: `test/onchain.test.ts`, `test/runner.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: `executeMutations` gains optional `onTransaction?: (hash: \`0x${string}\`, mutation: GroupMutation) => void`, invoked after each receipt confirms.

- [ ] **Step 1: Write the failing transaction-boundary tests**

Append to `test/onchain.test.ts`. Use the file's existing `as never` stub idiom — no `any`, no biome suppressions:

```ts
describe("executeMutations transaction reporting", () => {
  function stubClients(revertAt: number) {
    let index = 0;
    const publicClient = {
      simulateContract: async () => ({}),
      waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({
        status: hash === `0x${revertAt}` ? "reverted" : "success",
      }),
    };
    const walletClient = {
      writeContract: async () => {
        const hash = `0x${index}`;
        index += 1;
        return hash;
      },
    };
    return { publicClient, walletClient };
  }

  const mutations = [
    { operation: "add" as const, groupId: groupId(1), members: [addr("1")] },
    { operation: "add" as const, groupId: groupId(2), members: [addr("1")] },
    { operation: "remove" as const, groupId: groupId(4), members: [addr("2")] },
  ];

  it("reports every confirmed hash before a later revert", async () => {
    const seen: string[] = [];
    const { publicClient, walletClient } = stubClients(2);

    await expect(
      executeMutations({
        publicClient: publicClient as never,
        walletClient: walletClient as never,
        account: {} as never,
        registryAddress: addr("f"),
        mutations,
        onTransaction: (hash) => seen.push(hash),
      }),
    ).rejects.toThrow("reverted");

    expect(seen).toEqual(["0x0", "0x1"]);
  });

  it("stops at the failing boundary wherever it falls", async () => {
    for (const revertAt of [0, 1, 2]) {
      const seen: string[] = [];
      const { publicClient, walletClient } = stubClients(revertAt);

      await expect(
        executeMutations({
          publicClient: publicClient as never,
          walletClient: walletClient as never,
          account: {} as never,
          registryAddress: addr("f"),
          mutations,
          onTransaction: (hash) => seen.push(hash),
        }),
      ).rejects.toThrow("reverted");

      expect(seen).toHaveLength(revertAt);
    }
  });

  it("prevents every removal when an add fails", async () => {
    const attempted: string[] = [];
    let index = 0;
    const publicClient = {
      simulateContract: async () => ({}),
      waitForTransactionReceipt: async () => ({ status: "reverted" }),
    };
    const walletClient = {
      writeContract: async ({ functionName }: { functionName: string }) => {
        attempted.push(functionName);
        const hash = `0x${index}`;
        index += 1;
        return hash;
      },
    };

    await expect(
      executeMutations({
        publicClient: publicClient as never,
        walletClient: walletClient as never,
        account: {} as never,
        registryAddress: addr("f"),
        mutations,
      }),
    ).rejects.toThrow("reverted");

    expect(attempted).toEqual(["addMembers"]);
  });
});
```

Import `addr` and `groupId` from `./fixtures.js` and `executeMutations` from `../src/onchain.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/onchain.test.ts -t "transaction reporting"`
Expected: FAIL — `onTransaction` is not a recognised input.

- [ ] **Step 3: Add the callback to `executeMutations`**

Add to the input type after `mutations`:

```ts
  onTransaction?: (hash: `0x${string}`, mutation: GroupMutation) => void;
```

and after the receipt check:

```ts
    transactionHashes.push(hash);
    input.onTransaction?.(hash, mutation);
```

Without this, a mid-run revert discards the whole accumulated hash list, because `runner.ts` only logs it after `executeMutations` returns.

- [ ] **Step 4: Write the failing migration regression test**

Append to `test/runner.test.ts`. This is the deadlock the phase split exists to prevent, driven through the real plan builder and mutation selector:

```ts
describe("exclusive to cascading migration", () => {
  it("repairs a legacy PRO membership once backfill is complete", () => {
    const { desired, config, onchain } = planFixture();
    const wallet = addr("1");
    const policy = desired.policies.get("historical-taker");
    policy?.membersByTier.PEASANT.add(wallet);
    policy?.membersByTier.PEER.add(wallet);

    // Legacy exclusive state: PRO only.
    onchain.membersByGroupId.set(groupId(4), new Set([wallet]));

    // Run 1 — a budget of 1 leaves the PEER add deferred, so this is a genuine
    // BACKFILL. With a budget large enough to schedule both adds, deferredAdds
    // would be 0 and the very first run would select MIGRATION_REPAIR instead.
    const backfill = buildReconciliationPlan({ desired, config, onchain, batchSize: 100, addBudget: 1 });
    const backfillPhase = selectPhase({
      deferredAdds: backfill.deferredAdds,
      cascadeViolationCount: findCurrentCascadeViolations(config, onchain).length,
    });
    expect(backfill.deferredAdds).toBeGreaterThan(0);
    expect(backfillPhase).toBe("BACKFILL");
    applyMutations(onchain, mutationsForPhase(backfill, backfillPhase));

    // Run 2 — this is the spec's B2 case: totalAdds > 0 with deferredAdds == 0,
    // while PRO-without-PLUS still violates cascading.
    const repair = buildReconciliationPlan({ desired, config, onchain, batchSize: 100, addBudget: 100 });
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
    const settled = buildReconciliationPlan({ desired, config, onchain, batchSize: 100, addBudget: 100 });
    expect(findCurrentCascadeViolations(config, onchain)).toEqual([]);
    expect(
      selectPhase({ deferredAdds: settled.deferredAdds, cascadeViolationCount: 0 }),
    ).toBe("NORMAL");
  });

  it.each([
    ["PRO to PEER", 4, ["PEASANT", "PEER"] as const],
    ["PRO to PEASANT", 4, ["PEASANT"] as const],
    ["PLUS to PEER", 3, ["PEASANT", "PEER"] as const],
  ])("converges an exclusive %s transition", (_label, legacyGroup, desiredTiers) => {
    const { desired, config, onchain } = planFixture();
    const wallet = addr("1");
    const policy = desired.policies.get("historical-taker");
    for (const tier of desiredTiers) policy?.membersByTier[tier].add(wallet);
    onchain.membersByGroupId.set(groupId(legacyGroup), new Set([wallet]));

    for (let run = 0; run < 5; run += 1) {
      const plan = buildReconciliationPlan({ desired, config, onchain, batchSize: 100, addBudget: 100 });
      const phase = selectPhase({
        deferredAdds: plan.deferredAdds,
        cascadeViolationCount: findCurrentCascadeViolations(config, onchain).length,
      });
      applyMutations(onchain, mutationsForPhase(plan, phase));
    }

    expect(findCurrentCascadeViolations(config, onchain)).toEqual([]);
    const wanted: readonly string[] = desiredTiers;
    for (let id = 1; id <= 4; id += 1) {
      const tier = TIERS[id - 1];
      const expected = tier ? wanted.includes(tier) : false;
      expect(onchain.membersByGroupId.get(groupId(id))?.has(wallet) ?? false).toBe(expected);
    }
  });
});
```

Import `TIERS` from `../src/domain.js`, the plan/phase functions, and `addr`, `groupId`, `planFixture`, `applyMutations` from `./fixtures.js`.

- [ ] **Step 5: Wire the runner**

In `src/runner.ts`:

Rename the counts log key so cumulative counts are not misread as tier populations:

```ts
        cumulativeCounts: tierCounts(policy),
```

Rename the verify log key — `tierForAddress` now returns the highest tier held, or `NONE`:

```ts
        highestTier: {
          historicalTaker: tierForAddress(historical, address),
          currentEarn: tierForAddress(earn, address),
        },
```

Add the bounds check beside the existing completeness check:

```ts
  assertDesiredSnapshotComplete(desired, groups);
  assertDesiredSnapshotBounds(desired, groups);
```

Replace the composed mutation list from Task 5 with phase selection, and extend the plan log:

```ts
  const cascadeViolations = findCurrentCascadeViolations(groups, onchain);
  const phase = selectPhase({
    deferredAdds: plan.deferredAdds,
    cascadeViolationCount: cascadeViolations.length,
  });
  assertPlanSafe({ /* unchanged from Task 7 */ });

  const mutations = mutationsForPhase(plan, phase);

  logger.info(
    {
      rpcLatestBlock: rpcLatestBlock.toString(),
      snapshotBlock: onchain.snapshotBlock.toString(),
      indexedThroughBlock: onchain.indexedThroughBlock.toString(),
      phase,
      cascadeViolations,
      totalAdds: plan.totalAdds,
      deferredAdds: plan.deferredAdds,
      totalRemovals: plan.totalRemovals,
      removalWalletCount: plan.removalWalletCount,
      removalReasons: summarizeRemovalReasons(plan, desired, isBlockedWallet),
      removalsExecutable: phase !== "BACKFILL",
      transactionBatches: mutations.length,
      initialSeed: plan.initialSeed,
      groups: plan.groups.map((group) => ({
        scope: group.definition.scope,
        tier: group.definition.tier,
        groupId: group.definition.groupId.toString(),
        currentCount: group.currentCount,
        desiredCount: group.desiredCount,
        adds: group.additions.length,
        deferredAdds: group.deferredAdds,
        removals: group.removals.length,
      })),
    },
    settings.execute ? "Reconciliation plan approved for execution" : "Dry-run reconciliation plan",
  );
```

`isBlockedWallet` is already imported in this file. Replace the execution block's hash logging:

```ts
  const transactionHashes = await executeMutations({
    publicClient,
    walletClient,
    account,
    registryAddress: groups.registryAddress,
    mutations,
    onTransaction: (hash, mutation) =>
      logger.info(
        {
          hash,
          operation: mutation.operation,
          groupId: mutation.groupId,
          members: mutation.members.length,
        },
        "Registry transaction mined",
      ),
  });
  logger.info(
    { phase, transactionCount: transactionHashes.length },
    "On-chain group reconciliation completed",
  );
```

- [ ] **Step 6: Run the full check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/onchain.ts src/runner.ts test/onchain.test.ts test/runner.test.ts
git commit -m "feat(runner): execute reconciliation by derived phase"
```

---

### Task 9: Documentation, runbook, and compare-local support

**Files:**
- Modify: `README.md`
- Modify: `scripts/compare-local.ts`
- Verify: `docs/compatibility.md`, `pnpm check:upstream`

- [ ] **Step 1: Verify the upstream surface is unaffected**

Run: `pnpm check:upstream`
Expected: PASS. `AddressGroup` and `AddressGroupMember` are generic over `groupId`, so two more groups need no indexer schema change. If it fails, record the required upstream change in `docs/compatibility.md` before continuing.

- [ ] **Step 2: Verify the `addMembers` duplicate-member behaviour**

The spec flags this as an open question: `src/contracts.ts` holds a minimal copied ABI that does not reveal whether `addMembers` reverts when a member is already present. It matters because a replan against a stale indexer watermark can re-submit existing members, and `executeMutations` simulates before every write.

Check `AddressGroupRegistry.addMembers` in zkp2p-v2-contracts at the pinned commit `ce038e6c23d7cfe8fdec52ee36330a74a8478d1b` (`CONTRACTS_UPSTREAM_COMMIT`). Record the answer in the README recovery section:
- **reverts on duplicates** — every partial run MUST wait for the indexer watermark to cover all mined receipts before replanning.
- **tolerates duplicates** — a stale replan wastes gas but is safe.

- [ ] **Step 3: Update the README tier and safety sections**

- **High-level tiers**: four public groups per scope. Add the PEASANT row; state that the volume bands are entry floors while group membership is cumulative.
- **Safety model**: the bullet "Exact-tier groups: a member belongs to one tier per policy family" is now false — replace with "Cascading groups: a member of a tier belongs to every lower tier in the same policy family." Add the phase model, `ALLOW_MIGRATION_REMOVALS`, `MAX_REMOVAL_WALLETS`, `MAX_PLANNED_ADDS` vs `MAX_EXECUTED_ADDS_PER_RUN`.
- **New section, "Public means readable, not self-service"**: all eight groups are created with `isPublic == false`; `assertRegistryGovernance` rejects `isPublic == true` because that flag permits self-service membership.
- **Setup**: `config/groups.json` now needs eight group IDs with `minimumMembers` and `maximumMembers`.

- [ ] **Step 4: Replace the rollout section with the spec's eleven steps**

Copy the eleven-step sequence verbatim from the spec's "Rollout" section (create two groups → confirm indexed → pause cron → deploy code+config together → plan and approve removals → seed with `ALLOW_INITIAL_SEED=true` → watermark wait → repeat to `deferredAdds == 0` → gated `ALLOW_MIGRATION_REMOVALS` repair runs → confirm Phase C → `ALLOW_INITIAL_SEED=false` and resume cron). Include the warning that code and config are not independently rollback-compatible: the old binary requires exactly six group entries and the new one exactly eight.

- [ ] **Step 5: Add the recovery runbook**

The spec requires documented procedures the README does not yet have. Add a "Recovery" section covering four cases, each with the observed symptom, the operator check, and the safe resume condition:

1. **Failed batch mid-run** — the run throws on the first reverted transaction. Every mined hash was already logged by `onTransaction`. Resume by rerunning `plan`; the reconciler diffs against current state, so completed batches are not repeated.
2. **Stale indexer** — the watermark has not caught up to the mined receipts. `plan` will compute adds that already exist on-chain. Wait until `indexedThroughBlock` covers the last logged transaction's block before rerunning.
3. **Signer / RPC failure** — no transaction was submitted, or one was submitted without a receipt. Check the last "Registry transaction mined" log line, confirm on-chain, then rerun.
4. **Code rollback after the eight-group manifest is installed** — the six-group binary rejects the eight-entry config at startup. Revert `config/groups.json` and the code together; the two extra on-chain groups are inert while unconfigured.

- [ ] **Step 6: Make `compare-local.ts` cascading-aware**

The script reads one seed file per tier and diffs against the calculated snapshot, assuming exclusive sets. Define the input contract precisely and implement it:

- Seed files stay **exclusive** — one file per tier holding only that band's members. This keeps existing seed directories usable.
- Before diffing, expand them into the cascading prefix: the expected set for tier `T` is the union of the seed files for `T` and every tier above it.
- `peasant.txt` is **optional**. When absent, expected PEASANT is the union of all other tiers' seeds, which is exactly the cascading definition minus wallets that only ever qualified for PEASANT — so log a warning that PEASANT comparison is lower-bound only.
- Keep the existing `${scope}-3` directory preference and the `platinum.txt` fold into PRO, applying the fold **before** expansion so a legacy top-band wallet cascades correctly.
- Update the summary output to label counts as cumulative.

- [ ] **Step 7: Run the full check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add README.md scripts/compare-local.ts docs/compatibility.md
git commit -m "docs: document cascading tiers and phased rollout"
```

---

## Verification Before Merge

- [ ] `pnpm check` passes from a clean checkout.
- [ ] `pnpm calculate` runs against the public indexer and reports cumulative counts in the right shape: historical PEASANT >= PEER >= PLUS >= PRO, with PEASANT close to the total `TakerStats` row count (~10,061 as of 2026-07-27).
- [ ] `pnpm verify -- <a known PRO wallet>` reports `PRO`, not `PEASANT`. This is the regression the descending-iteration change exists to prevent.
- [ ] A `plan` run against production reports its phase, `deferredAdds`, `removalWalletCount`, and `removalReasons`, with no addresses anywhere in the output.
- [ ] The production `plan`'s removal report has been reviewed and approved before any `ALLOW_MIGRATION_REMOVALS=true` run.
