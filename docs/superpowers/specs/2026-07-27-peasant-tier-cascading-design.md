# Design: Cascading tiers + public PEASANT group (zkp2p/peer-curator)

Status: implemented, split across two branches.
Reviewed via Claude + Codex convergence, 3 rounds, converged.
Production measurements in this document were taken 2026-07-27 against the live Base indexer.

**This document designs two changes that ship separately.** It is retained whole because the
reasoning only makes sense together — the phase model, mutation ordering and removal-reason
reporting exist to migrate the deployed exclusive groups to cascading, independently of how many
tiers there are.

- `feat/cascading-tiers` — makes the existing PEER/PLUS/PRO groups cascading. Six groups.
  Everything in sections 2.1 through 3 lands here.
- `feat/peasant-tier` — adds PEASANT as a fourth public tier in both scopes. Eight groups.
  Only the tier-ladder additions in section 1 and the config/bounds rows for the two new groups
  land here.

Where this document says "eight groups" or quotes a 15,559-membership seed, that is the combined
end state. The cascading-only change is 3,684 memberships against ~2,350 deployed, so roughly
1,350 net adds — one run at the default budget.

Two items are deliberately left as verification tasks rather than decisions, and must be
resolved during implementation: whether `addMembers` reverts on an already-present member
(section 3), and whether `scripts/compare-local.ts` is updated for cascading seeds or
explicitly scoped out (section 3).

## Repo context (existing behaviour, before this change)

`peer-curator` calculates desired membership for `AddressGroupRegistry` groups and reconciles
them on-chain. Two policy scopes (`historical-taker`, `current-earn`) x three tiers
(`PEER`, `PLUS`, `PRO`) = 6 groups today.

Key existing files:
- `src/domain.ts` — `TIERS = ["PEER","PLUS","PRO"]`, `POLICY_SCOPES`, `emptyTierSets()`,
  `tierCounts()`, `tierForAddress()` (returns `Tier | "PEASANT"`, iterates TIERS ascending,
  returns first match).
- `src/policies.ts` — `TIER_ORDER = ["PEASANT","PEER","PLUS","PRO","TOP"]`, `classifyTier()`,
  `addMember()` (early-returns on PEASANT, folds TOP into PRO), `assertExclusive()`
  (throws on any address in 2+ tiers), the two `TierPolicy` constants.
- `src/reconcile.ts` — `buildReconciliationPlan()` (diff desired vs on-chain, chunk by
  BATCH_SIZE, adds first then removals), `assertDesiredSnapshotComplete()` (independent
  cross-tier duplicate check + config coverage check), `assertPlanSafe()` (initialSeed gate,
  MAX_TOTAL_ADDS, MAX_TOTAL_REMOVALS, minimumMembers, MAX_REMOVAL_BPS_PER_GROUP).
- `src/config.ts` — zod env schema; `groupFileSchema` requires exactly 6 groups
  (`.length(6)`); `validateGroupCoverage()` loops POLICY_SCOPES x TIERS.
- `src/runner.ts` — orchestration; logs `tierCounts(policy)`; `verify` uses `tierForAddress`;
  logs transaction hashes only after `executeMutations` returns (`runner.ts:185`).
- `src/onchain.ts` — `assertRegistryGovernance()` rejects `isPublic` groups (`:96`);
  `executeMutations()` simulates then writes each batch sequentially, waits 1 confirmation,
  throws on revert (`:161`), returns hashes only at the end (`:166`).
- `src/contracts.ts` — minimal copied ABI surface; does not reveal whether `addMembers`
  reverts on an already-present member.
- `src/staticWalletRules.ts` — 25 blocked wallet keccak hashes; `isBlockedWallet()`.
- `scripts/compare-local.ts` — compares calculated snapshot against local per-tier seed files;
  union summary assumes exclusive sets; folds legacy `platinum.txt` into PRO.
- Commands: `calculate`, `verify`, `plan`, `sync`. `sync` sends txs only with `EXECUTE=true`.
- Runs on Railway cron every 12h. Fail-closed on indexer watermark drift, missing groups,
  member-count mismatch, wrong curator, etc.

Tier calculation (unchanged by this design):
- historical-taker volume = `TakerStats.totalFulfilledVolume`;
  thresholds PEER 500e6 / PLUS 2_000e6 / PRO 10_000e6 / TOP 25_000e6 (6-dp USDC).
- current-earn volume = `sum(MakerPlatformStats.totalAmountTakenPreEarnCutover)` +
  `MakerPeerPayStats.ppTakenPostEarnCutover`;
  thresholds PEER 1_000e6 / PLUS 10_000e6 / PRO 50_000e6 / TOP 100_000e6.
- Both: `dilutedLockScore = lockScore / max(TakerStats.totalFulfilledVolume, 250e6)`
  (bigint floor division), demote one tier per crossed threshold
  ([50,200,500,1000] historical, [100,400,1000,2000] earn), clamped at index 0.
- `TOP` is an internal band only; it folds into the public `PRO` group.
- current-earn pulls lockScore and the dilution denominator from `TakerStats`; a maker with
  no taker row gets lockScore 0 and therefore no penalty.
- `PolicySnapshot.sourceRows` for current-earn is `platformStats.length + peerPayStats.length`
  (`policies.ts:112`) — a raw row count, NOT the unique candidate count.

## Terminology: "public" is overloaded — read this before implementing

The user requirement is that PEASANT be a **publicly consumable** group: any contract or
service can call `members(peasantGroupId, wallet)` and get a meaningful answer.

That is NOT the registry's `isPublic` flag. `getGroup` returns `bool isPublic`, and
`assertRegistryGovernance` **rejects any configured group with `isPublic == true`**
(`src/onchain.ts:96`) because that flag permits self-service membership, which would let
anyone add themselves and destroy the curated semantics.

**All eight groups, PEASANT included, must be created with `isPublic == false` and a curator
equal to the signer.** "Public" in this design means publicly readable, never self-service.

## Measured production data (Base 8453, live indexer, measured 2026-07-27)

Source rows: TakerStats 10,061; MakerPlatformStats 2,341; MakerPeerPayStats 379.
current-earn candidates (union of maker addresses) = 1,797.

Exclusive (current model) tier populations:

| | PEASANT(excl) | PEER | PLUS | PRO(incl TOP) |
|---|---:|---:|---:|---:|
| historical-taker | 8,349 | 856 | 645 | 211 |
| current-earn | 1,159 | 419 | 154 | 65 |

Other measurements:
- historical: 4,807 wallets have exactly 0 fulfilled volume; 63 more are under $1.
- historical: 2,872 wallets have nonzero lockScore; 1,342 already carry >=1 penalty level;
  143 currently sit below their volume band due to penalties (124 by one tier, 19 by 2+).
- current-earn: 169 candidates at zero volume; 15 currently demoted (11 by one, 4 by 2+).

Cascading (new model) group populations:

| Group | historical-taker | current-earn |
|---|---:|---:|
| PEASANT (everyone) | 10,061 | 1,797 |
| PEER (PEER+PLUS+PRO) | 1,712 | 638 |
| PLUS (PLUS+PRO) | 856 | 219 |
| PRO (PRO+TOP) | 211 | 65 |

Total memberships to materialize: 15,559 (vs 11,858 for an exclusive 8-group model,
vs 2,350 for the current deployed 6-group exclusive model).

These numbers are a single snapshot taken on 2026-07-27 and are the basis for every
`minimumMembers` / `maximumMembers` value below. Record that date beside the constants;
otherwise the thresholds become unexplained configuration debt.

## Decisions taken (by the user, during brainstorming)

1. PEASANT becomes a real public group, in BOTH scopes -> 8 groups total.
2. PEASANT is the full complement: every wallet with a source row that doesn't reach PEER,
   INCLUDING wallets with exactly zero volume. No dust floor.
3. Tiers are CASCADING / nested, materialized on-chain: PRO members are also written into
   PLUS, PEER and PEASANT. Consumers do a single `members(groupId, wallet)` call.
4. Demotion is retained (NOT append-only / high-water-mark). Lock-score penalties can move a
   wallet down, and denylist additions evict. Removals therefore still exist.

## Section 1 — Tier model and policy calculation

`src/domain.ts`:
- `TIERS = ["PEASANT", "PEER", "PLUS", "PRO"] as const` — ordering is now load-bearing
  (ascending). Stays an `as const` array rather than a TS enum because ordering/iteration
  are load-bearing and the codebase is built on that pattern.
- `tierForAddress` returns `Tier | "NONE"`. `NONE` still occurs for blocked wallets and for
  wallets absent from a scope's source rows.
- **`tierForAddress` MUST iterate TIERS descending** and return the highest tier the address
  appears in. The current implementation iterates ascending and returns the first hit
  (`src/domain.ts:79-84`), which under cascading would return PEASANT for every wallet
  including PRO ones. This is the one place cascading silently breaks working code instead
  of failing loudly.
- `emptyTierSets()` gains a PEASANT set. `tierCounts()` gains PEASANT and now reports
  CUMULATIVE counts — the `runner.ts:64` log line must say so explicitly.

`src/policies.ts`:
- `addMember` replaces its early return with a prefix fill:
  `publicTier = tier === "TOP" ? "PRO" : tier`, then add the address to
  `TIERS[0..indexOf(publicTier)]` inclusive.
- No early-return case remains: the `Math.max(0, ...)` clamp in `classifyTier`
  (`src/policies.ts:57`) guarantees the computed tier is never below PEASANT.
- `assertExclusive` -> `assertCascading(membersByTier)`: for each adjacent tier pair, the
  higher tier's set must be a SUBSET of the lower tier's set.
- `ComputedMemberTier` renamed to `ThresholdTier` — `thresholds` only holds the four upper
  bands; PEASANT deliberately has no threshold because it is the floor.
- `classifyTier` itself is unchanged.

## Section 2 — Reconciliation, ordering, safety limits

### 2.1 The prefix property is CONDITIONAL

Under cascading, a wallet's DESIRED membership is always a prefix `[PEASANT..T]`. If the
CURRENT on-chain membership is also a valid prefix, then:
- promotion is adds-only, demotion is removals-only;
- no wallet has both an add and a removal in the same run;
- any interrupted add sequence ordered bottom-up leaves a valid prefix.

**None of that holds when the current state is not already cascading**, which is exactly the
situation during migration from the deployed exclusive groups. Counterexample:

- current (exclusive): wallet in `PRO` only
- calculation demotes it to `PEER`; desired cascading: `{PEASANT, PEER}`
- plan: add PEASANT, add PEER, remove PRO — **both adds and a removal for one wallet**
- after the adds but before the removal: `{PEASANT, PEER, PRO}` — not a valid prefix

`buildReconciliationPlan` computes independent per-group set differences and never reasons
about wallet-level transitions (`reconcile.ts:52`), and `executeMutations` has no rollback or
continuation marker (`onchain.ts:122-166`). So the invariant must be established, not assumed.

### 2.2 Four explicit phases

A three-phase model (validate / add-only backfill / normal) **deadlocks**. Worked example:

- current `{PRO}`, desired `{PEASANT, PEER}` (legacy exclusive member, since demoted)
- backfill adds PEASANT and PEER -> current is now `{PEASANT, PEER, PRO}`
- `deferredAdds == 0`, but the state is still non-cascading (PRO without PLUS)
- an add-only backfill phase forbids the removal of PRO — the only operation that fixes it
- so every subsequent run re-selects backfill and does nothing, forever

The violation is only repairable by a removal, so a phase that forbids removals whenever the
cascade check fails can never clear it. Backfill therefore splits in two:

**Phase A — Calculate / validate.** Produce cascading desired sets. Validate lower bounds,
upper bounds, and nesting before anything else runs.

**Phase B1 — Backfill (add-only).** Selected when `deferredAdds > 0`. Adds only, lowest tier
first, budgeted. No removals execute.

**Phase B2 — Migration repair (removals permitted).** Selected when `deferredAdds == 0` AND
`assertCurrentCascading` fails. Removals execute highest-tier-first.

The safety argument needs care: `deferredAdds == 0` does NOT by itself mean
`current ⊇ desired`. It means no addition was truncated out of this run — `totalAdds` may
still be positive, with those adds pending execution. The relation is established by the
execution order, not by the plan:

- all planned additions execute and confirm before any removal (adds-before-removals);
- if any addition fails, `executeMutations` throws and no removal runs at all
  (`onchain.ts:161`);
- therefore, immediately before the first B2 removal, `current ⊇ desired` does hold;
- every removal is drawn from `current \ desired`, and with highest-tier-first ordering over
  an already-materialized lower-tier prefix, no removal can introduce a new cascade violation.
  The state converges monotonically to `desired`.

Requires the explicit `ALLOW_MIGRATION_REMOVALS=true` approval gate (section 3), since this is
where legacy memberships get stripped.

**Phase C — Normal reconciliation.** Selected when `deferredAdds == 0` AND the current state
satisfies cascading. Adds bottom-up, then removals top-down, with the full destructive limits.
A newly detected violation drops back to B2, not B1.

| `deferredAdds` | cascade check | phase |
|---|---|---|
| `> 0` | either | B1 (add-only) |
| `== 0` | fails | B2 (repair, gated) |
| `== 0` | passes | C (normal) |

Phase selection is DERIVED from the plan, never from operator-managed state or group
emptiness: both inputs are computed from the actual diff rather than inferred from incidental
membership, so a derived gate cannot be left in the wrong position by a human or a crashed
process. The one human input is `ALLOW_MIGRATION_REMOVALS`, and that is deliberately a
different kind of gate — derived logic decides *which phase we are in*, human gates decide
*whether a destructive action is authorized*. That matches the existing `ALLOW_INITIAL_SEED`
and `EXECUTE` pattern rather than introducing a competing source of truth.

`initialSeed` keeps its existing `every(currentCount === 0)` definition and
`ALLOW_INITIAL_SEED` keeps its existing meaning (a human gate on the very first write). An
earlier draft changed it to `some(...)`; that is DROPPED — the derived phase gate solves the
real problem properly, and the `some` variant was a band-aid that still fails once every group
is incidentally nonempty.

### 2.3 Preflight cascade assertion on current state

New `assertCurrentCascading(onchain, config)`: for each scope, for each adjacent tier pair,
every member of the higher group must also be a member of the lower group, using the indexed
`AddressGroupMember` sets already fetched. Result feeds phase selection (2.2) rather than
throwing outright — a violation is expected during migration and is exactly what Phase B2
repairs. Log violation counts per scope/tier pair, never addresses.

### 2.4 Mutation ordering

- **Adds: lowest tier first.** Guarantees prefix-valid intermediate states once 2.3 holds.
- **Removals: highest tier first.** Bottom-up removal could strand a wallet in PRO but not
  PEASANT, where `members(PEER)` says no while `members(PRO)` says yes.
- Sort explicitly by tier index; do NOT rely on `config.groups` array order, which is
  operator-controlled.
- Existing adds-before-removals ordering across the whole plan is retained.

### 2.5 Truncation

Because all lower-tier adds precede higher-tier ones, cutting the add list at any budget
boundary leaves prefix-valid states — but only in Phase C, and only combined with the Phase B1
rule that removals never execute alongside deferred adds.

`ReconciliationPlan` must make truncation explicit rather than leaving three fields that
silently disagree:
- `groups[].additions` / `groups[].removals`, `totalAdds` / `totalRemovals` — the FULL
  pre-truncation plan (what validation and `minimumMembers` reason about).
- `mutations` — POST-truncation, what will actually be executed.
- new `deferredAdds` count plus per-group deferred counts, logged every run.

### 2.6 Limits

Renamed for clarity, since the two add limits measure different things:
- `MAX_PLANNED_ADDS` (was `MAX_TOTAL_ADDS`, raised to 25000) — hard abort, blast-radius guard.
- `MAX_EXECUTED_ADDS_PER_RUN` (new, 3000) — soft per-run execution budget, truncates.

**Planned-add count is a poor calculation-bug detector** because it depends on current
on-chain state: the same erroneous desired snapshot can exceed the ceiling on its first run
and fall under it after partial application. So validate the DESIRED SNAPSHOT independently,
state-free:
- `minimumMembers` per group (existing, re-sized below) — lower bound on `desiredCount`.
- `maximumMembers` per group (NEW) — upper bound on `desiredCount`.
- **cascading count monotonicity**: `count(PEASANT) >= count(PEER) >= count(PLUS) >=
  count(PRO)` per scope. Free, state-free, catches a whole class of calculation bugs.
- `MAX_PLANNED_ADDS` demoted to a secondary guard.

**Removal limits count memberships, not wallets.** Under cascading one blocked PRO wallet
produces 4 removals per scope, up to 8 across both. So `MAX_TOTAL_REMOVALS=100` means as few
as ~13 high-tier wallets, not 100 people. Therefore:
- keep `MAX_TOTAL_REMOVALS=100` on membership operations, and
- add `MAX_REMOVAL_WALLETS` (new, 50) on the count of DISTINCT addresses affected by removals,
- log both figures every run.

`MAX_REMOVAL_BPS_PER_GROUP=500` is inert for the 10,061-member PEASANT group (it permits ~503
removals while the global limit of 100 fires first). It still binds for small groups — for
current-earn PRO at 65 members, 4 removals already exceeds 500 bps. Left as-is, documented.

`minimumMembers` re-sized to ~80% of the 2026-07-27 measurement; `maximumMembers` to ~150%:

| | PEASANT min/max | PEER min/max | PLUS min/max | PRO min/max |
|---|---|---|---|---|
| historical-taker | 8000 / 15000 | 1350 / 2600 | 680 / 1300 | 165 / 320 |
| current-earn | 1400 / 2700 | 500 / 960 | 175 / 330 | 50 / 100 |

What `minimumMembers` actually catches: sufficiently large undercounts. It does NOT catch
distorted source composition when cardinality stays above the floor, and gives no upper-side
protection — hence `maximumMembers` and the monotonicity check. During initial seed the
removal-BPS checks are skipped for empty groups (`reconcile.ts:145`), so these bounds are the
main statistical guard at exactly the moment the most data is written.

`assertDesiredSnapshotComplete` swaps its cross-tier duplicate scan (`reconcile.ts:101-108`)
for the cascading assertion, preserving a second independent guard at plan time.

### 2.7 Validation must be split by phase

`assertPlanSafe` currently rejects the whole plan on pre-truncation removal counts before any
execution (`reconcile.ts:133`). Left as-is, 101 planned removals — or one small group over its
BPS limit — would abort a completely safe add-only Phase B1 run, stalling the backfill on a
constraint that phase cannot violate. Split it three ways:

- **Always enforced:** desired-snapshot bounds (`minimumMembers`, `maximumMembers`, count
  monotonicity), `MAX_PLANNED_ADDS`, and the `ALLOW_INITIAL_SEED` gate.
- **Always reported, never blocking:** removal counts by scope/tier and distinct-wallet
  totals, so operators see what is pending even during B1.
- **Enforced only before a phase that can execute removals (B2, C):** `MAX_TOTAL_REMOVALS`,
  `MAX_REMOVAL_WALLETS`, `MAX_REMOVAL_BPS_PER_GROUP`.

## Section 3 — Config, rollout, testing

**Config surface:**
- `groupFileSchema` `.length(6)` -> `.length(8)`; group entries gain `maximumMembers`.
  The tier enum derives from `TIERS` so it picks up PEASANT automatically, as does
  `validateGroupCoverage`'s scope x tier loop (`src/config.ts:134-140`).
- `config/groups.example.json` gains two entries and the min/max bounds.
- Env: `MAX_TOTAL_ADDS` -> `MAX_PLANNED_ADDS=25000`; new `MAX_EXECUTED_ADDS_PER_RUN=3000`;
  new `MAX_REMOVAL_WALLETS=50`; new `ALLOW_MIGRATION_REMOVALS=false` (Phase B2 gate).
  `.env.example` updated.
- README: tier table, the now-false "Exact-tier groups: a member belongs to one tier per
  policy family" safety bullet, the isPublic clarification, and the rollout section.

**Upstream:** `AddressGroup` / `AddressGroupMember` are already generic over `groupId`, so two
more groups need no indexer schema change. `docs/compatibility.md` and `pnpm check:upstream`
should be unaffected — confirm during implementation, do not assume.

**Migration removals are a HYPOTHESIS, not a proven property.** Cascading desired membership
is a superset of the same calculation's exclusive desired membership — that says nothing about
the DEPLOYED state. Removals can legitimately appear if production was seeded from an older
snapshot, if volume or lock-score moved since, if blocked-wallet rules changed, if local seed
generation differed from current policy code, or if production holds manual/stale memberships.
`config/groups.json` is untracked so production state could not be verified during design.
Required before rollout: a real production `plan` producing a removals-by-scope/tier report
with reason categories and no addresses. Any migration removal is a separate approval gate.

**Open question for implementation:** does `addMembers` revert on an already-present member?
`src/contracts.ts` is a minimal copied ABI and does not say. It matters because a replan
against a stale indexer watermark could re-add existing members. `executeMutations` simulates
before every write (`onchain.ts:125`), so a reverting contract fails closed — acceptable but
noisy. Verify against zkp2p-v2-contracts before the first seed run.

**`scripts/compare-local.ts`** needs more than a `peasant.txt` file: its union summary assumes
exclusive sets and it folds legacy `platinum.txt` into PRO (`compare-local.ts:61`). Either
give it an explicit cascading seed format or scope it out of this change deliberately.

**Rollout:**
1. Create the two new groups on-chain, `isPublic == false`, curator == signer.
2. Confirm the indexer has both `AddressGroup` rows.
3. **Pause the Railway cron.** Migration runs are manual and observed.
4. Deploy code + 8-entry `config/groups.json` together (they are not independently
   rollback-compatible: the old binary requires exactly 6 entries, the new one exactly 8 —
   a rollback must revert both).
5. `plan`, inspect the removals report, get the separate approval if it is nonempty.
6. Seed with `ALLOW_INITIAL_SEED=true`. Expect **~6 runs** for a fully empty deployment
   (`ceil(15559 / 3000) = 6`), fewer if production is already seeded — measure the real diff
   rather than trusting this estimate.
7. After each partial run, wait until the indexer watermark covers all mined receipts before
   replanning.
8. Repeat until `plan` reports `deferredAdds == 0`. The service is now in Phase B1-complete.
9. If the cascade preflight still fails, the service selects Phase B2. Review the removals
   report, then set `ALLOW_MIGRATION_REMOVALS=true` for the approved run and return it to
   `false` immediately after. Repeat until the preflight passes.
10. Once `deferredAdds == 0` and the preflight passes, the service is in Phase C.
11. Set `ALLOW_INITIAL_SEED=false`, resume cron.

**Operability fix required before any of this:** `executeMutations` accumulates
`transactionHashes` and returns them only at the end (`onchain.ts:164-166`), and `runner.ts:185`
logs them only on success — so a mid-run revert loses the record of every transaction already
mined. Log each hash immediately after its receipt confirms. Without this, recovering from a
failed seed run means reconstructing state from chain logs.

Document recovery procedures for: failed batch mid-run, stale indexer, signer/RPC failure,
and code rollback after the 8-group manifest is installed.

**Testing:**
- `tierForAddress` returns the HIGHEST tier — a PRO wallet must not report PEASANT.
- Cascading prefix property holds for every calculated snapshot.
- `assertCascading` throws on a hand-built violation; `assertCurrentCascading` detects an
  exclusive-style current state and selects Phase B1 or B2 per the 2.2 table.
- **Deadlock regression:** current `{PRO}`, desired `{PEASANT, PEER}`. After backfill the
  state is `{PEASANT, PEER, PRO}` with `deferredAdds == 0` and a failing cascade check; the
  run MUST select B2 and remove PRO rather than re-selecting an add-only phase forever.
- Phase B1 is not aborted by removal-limit breaches: a plan with 101 pending removals and
  `deferredAdds > 0` still executes its adds (2.7).
- B2 selected with `totalAdds > 0` and `deferredAdds == 0`: every add confirms before the
  first removal is submitted, and an add failure prevents all removals.
- Exclusive -> cascading transitions specifically: `PRO -> PEER`, `PRO -> PEASANT`,
  `PLUS -> PEER`, with failure injected after every transaction boundary.
- Add mutations ordered bottom-up, removals top-down, regardless of `config.groups` order.
- Truncation at an arbitrary budget leaves prefix-valid states.
- No removal is executed while `deferredAdds > 0`.
- Multi-run convergence where the budget boundary falls before a demoted wallet's
  prerequisite adds.
- One blocked PRO wallet in both scopes (8 membership removals, 1 distinct wallet) against
  `MAX_TOTAL_REMOVALS` and `MAX_REMOVAL_WALLETS`; and 101 PEASANT-only removals.
- `maximumMembers` and count-monotonicity validation reject a distorted snapshot.
- Config rejects a 6-group file; rejects duplicate scope/tier.
- A blocked wallet appears in no group at any tier.
