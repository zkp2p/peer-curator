# Design: Cascading address group tiers (zkp2p/peer-curator)

> Superseded for Current Earn: the active runtime intentionally supports only
> the `historical-taker` Peer/Plus/Pro groups. The Current-Earn material below
> is retained solely as design history and must not be used as an active
> deployment manifest.

Status: implemented and merged (PR #2).
Reviewed via Claude + Codex convergence, 3 rounds, converged.
Production measurements taken 2026-07-27 against the live Base indexer.

Converts the six exclusive `AddressGroupRegistry` groups into cascading ones, where each tier's
group contains every higher tier's members. Tier names and volume bands are unchanged.

A follow-up change adds a fourth PEASANT tier on top of this, taking the group count to eight.
That design is specified separately and nothing here depends on it. Note that `PEASANT` already
exists in this codebase as the computed band meaning "not curated" — a sentinel, not a group.

## Repo context (before this change)

Two policy scopes (`historical-taker`, `current-earn`) × three tiers (`PEER`, `PLUS`, `PRO`) =
6 groups, with **exact** membership: a wallet belonged to exactly one tier per scope.

- `src/domain.ts` — `TIERS`, `POLICY_SCOPES`, `emptyTierSets()`, `tierCounts()`,
  `tierForAddress()` (iterated TIERS ascending, returned the first match).
- `src/policies.ts` — `TIER_ORDER`, `classifyTier()`, `addMember()` (wrote one set),
  `assertExclusive()` (threw on any address in 2+ tiers).
- `src/reconcile.ts` — `buildReconciliationPlan()`, `assertDesiredSnapshotComplete()`,
  `assertPlanSafe()`.
- `src/onchain.ts` — `assertRegistryGovernance()` rejects `isPublic` groups (`:96`);
  `executeMutations()` simulates then writes each batch sequentially, throws on revert (`:161`),
  returned hashes only at the end (`:166`).
- `src/runner.ts` — logged transaction hashes only after `executeMutations` returned.
- `scripts/compare-local.ts` — compared against per-tier seed files, assuming exclusive sets.

Tier calculation is **unchanged** by this design: volume definitions, thresholds, the
`lockScore / max(totalFulfilledVolume, 250 USDC)` dilution, the one-tier-per-crossed-threshold
demotion, and the fold of the internal `TOP` band into public `PRO` all stay as they were.

## Terminology: "public" is overloaded

These groups are **publicly readable** — any contract or service can call
`members(groupId, wallet)`.

That is NOT the registry's `isPublic` flag. `getGroup` returns `bool isPublic`, and
`assertRegistryGovernance` **rejects any configured group with `isPublic == true`**
(`src/onchain.ts:96`) because that flag permits self-service membership, which would let anyone
add themselves and destroy the curated semantics. All groups are `isPublic == false` with a
curator equal to the signer.

## Measured production data (Base 8453, live indexer, 2026-07-27)

Source rows: TakerStats 10,061; MakerPlatformStats 2,341; MakerPeerPayStats 379.
current-earn candidates (union of maker addresses) = 1,797.

Exclusive (previous) populations → cascading (new) group populations:

| | PEER | PLUS | PRO |
|---|---|---|---|
| historical-taker | 856 → 1,712 | 645 → 856 | 211 → 211 |
| current-earn | 419 → 638 | 154 → 219 | 65 → 65 |

Total memberships: **3,684 cascading** versus 2,350 exclusive — roughly 1,350 net adds.

Post-denylist counts from a live `pnpm calculate` after implementation: 1,704 / 849 / 210
historical and 638 / 219 / 65 earn.

These figures are one snapshot and are the basis for every `minimumMembers` / `maximumMembers`
value below. Record that date beside the constants; otherwise the thresholds become unexplained
configuration debt.

## Section 1 — Tier model and policy calculation

`src/domain.ts`:
- `TIERS` order becomes **load-bearing** (ascending). The values are unchanged.
- **`tierForAddress` MUST iterate TIERS descending** and return the highest tier the address
  appears in. The previous implementation iterated ascending and returned the first hit, which
  under cascading would report the lowest tier for every curated wallet. This is the one place
  cascading silently breaks working code instead of failing loudly.
- `tierCounts()` now reports CUMULATIVE counts — the `runner.ts` log line must say so
  explicitly, or operators will misread them as tier populations.

`src/policies.ts`:
- `addMember` replaces its single-set write with a prefix fill: add the address to every tier
  from the floor up to its computed tier inclusive.
- `assertExclusive` → `assertCascadingSets(membersByTier, label)`: for each adjacent tier pair,
  the higher tier's set must be a SUBSET of the lower tier's set. Same defense-in-depth role,
  inverted invariant.
- `classifyTier` itself is unchanged.

## Section 2 — Reconciliation, ordering, safety limits

### 2.1 The prefix property is CONDITIONAL

Under cascading, a wallet's DESIRED membership is always a prefix `[PEER..T]`. If the CURRENT
on-chain membership is also a valid prefix, then:
- promotion is adds-only, demotion is removals-only;
- no wallet has both an add and a removal in the same run;
- any interrupted add sequence ordered bottom-up leaves a valid prefix.

**None of that holds when the current state is not already cascading**, which is exactly the
situation during migration from the deployed exclusive groups. Counterexample:

- current (exclusive): wallet in `PRO` only
- calculation demotes it to `PEER`; desired cascading: `{PEER}`
- plan: add PEER, remove PRO — **both an add and a removal for one wallet**
- after the add but before the removal: `{PEER, PRO}` — not a valid prefix

`buildReconciliationPlan` computes independent per-group set differences and never reasons about
wallet-level transitions, and `executeMutations` has no rollback or continuation marker. So the
invariant must be established, not assumed.

### 2.2 Four explicit phases

A three-phase model (validate / add-only backfill / normal) **deadlocks**. Worked example:

- current `{PRO}`, desired `{PEER}` (legacy exclusive member, since demoted)
- backfill adds PEER → current is now `{PEER, PRO}`
- `deferredAdds == 0`, but the state is still non-cascading (PRO without PLUS)
- an add-only backfill phase forbids the removal of PRO — the only operation that fixes it
- so every subsequent run re-selects backfill and does nothing, forever

The violation is only repairable by a removal, so a phase that forbids removals whenever the
cascade check fails can never clear it. Backfill therefore splits in two:

**Phase A — Calculate / validate.** Produce cascading desired sets. Validate lower bounds, upper
bounds, and nesting before anything else runs.

**Phase B1 — Backfill (add-only).** Selected when `deferredAdds > 0`. Adds only, lowest tier
first, budgeted. No removals execute.

**Phase B2 — Migration repair (removals permitted).** Selected when `deferredAdds == 0` AND the
cascade preflight fails. Removals execute highest-tier-first.

The safety argument needs care: `deferredAdds == 0` does NOT by itself mean `current ⊇ desired`.
It means no addition was truncated out of this run — `totalAdds` may still be positive, with
those adds pending execution. The relation is established by the execution order, not the plan:

- all planned additions execute and confirm before any removal (adds-before-removals);
- if any addition fails, `executeMutations` throws and no removal runs at all (`onchain.ts:161`);
- therefore, immediately before the first B2 removal, `current ⊇ desired` does hold;
- every removal is drawn from `current \ desired`, and with highest-tier-first ordering over an
  already-materialized lower-tier prefix, no removal can introduce a new cascade violation. The
  state converges monotonically to `desired`.

Requires the explicit `ALLOW_MIGRATION_REMOVALS=true` approval gate, since this is where legacy
memberships get stripped.

**Phase C — Normal reconciliation.** Selected when `deferredAdds == 0` AND the current state
satisfies cascading. Adds bottom-up, then removals top-down, with the full destructive limits.
A newly detected violation drops back to B2, not B1.

| `deferredAdds` | cascade check | phase |
|---|---|---|
| `> 0` | either | B1 (add-only) |
| `== 0` | fails | B2 (repair, gated) |
| `== 0` | passes | C (normal) |

Phase selection is DERIVED from the plan, never from operator-managed state or group emptiness:
both inputs are computed from the actual diff rather than inferred from incidental membership,
so a derived gate cannot be left in the wrong position by a human or a crashed process. The one
human input is `ALLOW_MIGRATION_REMOVALS`, and that is deliberately a different kind of gate —
derived logic decides *which phase we are in*, human gates decide *whether a destructive action
is authorized*, matching the existing `ALLOW_INITIAL_SEED` and `EXECUTE` pattern.

`initialSeed` keeps its existing `every(currentCount === 0)` definition.

### 2.3 Preflight cascade assertion on current state

`findCurrentCascadeViolations(config, onchain)`: for each scope and adjacent tier pair, every
member of the higher group must also be a member of the lower group, using the indexed
`AddressGroupMember` sets already fetched. The result feeds phase selection rather than throwing
— a violation is expected during migration and is exactly what Phase B2 repairs. Log violation
counts per scope/tier pair, never addresses.

### 2.4 Mutation ordering

- **Adds: lowest tier first.** Guarantees prefix-valid intermediate states once 2.3 holds.
- **Removals: highest tier first.** Bottom-up removal could strand a wallet in PRO but not PEER,
  where `members(PEER)` says no while `members(PRO)` says yes.
- Sort explicitly by tier index; do NOT rely on `config.groups` array order, which is
  operator-controlled.
- Adds-before-removals across the whole plan is retained.

### 2.5 Truncation

Because all lower-tier adds precede higher-tier ones, cutting the add list at any budget boundary
leaves prefix-valid states — but only in Phase C, and only combined with the Phase B1 rule that
removals never execute alongside deferred adds.

`ReconciliationPlan` makes truncation explicit rather than leaving fields that silently disagree:
- `groups[].additions` / `removals`, `totalAdds` / `totalRemovals` — the FULL pre-truncation plan
  (what validation reasons about).
- `addMutations` — POST-truncation, what will actually be executed.
- `deferredAdds` plus per-group deferred counts, logged every run.

### 2.6 Limits

- `MAX_PLANNED_ADDS` (25000) — hard abort, blast-radius guard.
- `MAX_EXECUTED_ADDS_PER_RUN` (3000) — soft per-run execution budget, truncates.

**Planned-add count is a poor calculation-bug detector** because it depends on current on-chain
state: the same erroneous desired snapshot can exceed the ceiling on its first run and fall under
it after partial application. So validate the DESIRED SNAPSHOT independently, state-free:
- `minimumMembers` per group — lower bound on `desiredCount`.
- `maximumMembers` per group — upper bound.
- **cascading count monotonicity** per scope. Free, state-free, catches a class of calculation
  bugs. Deliberately redundant with `assertCascadingSets` as a cheap cross-check.
- `MAX_PLANNED_ADDS` demoted to a secondary guard.

**Removal limits count memberships, not wallets.** Under cascading one blocked PRO wallet
produces 3 removals per scope, up to 6 across both. So `MAX_TOTAL_REMOVALS=100` means as few as
~16 high-tier wallets, not 100 people. Therefore add `MAX_REMOVAL_WALLETS` (50) on the count of
DISTINCT addresses affected, and log both figures every run.

`MAX_REMOVAL_BPS_PER_GROUP=500` is near-inert for the largest group but still binds for small
ones — for current-earn PRO at 65 members, 4 removals already exceeds 500 bps. Left as-is.

Bounds, set to ~80% and ~150% of the 2026-07-27 measurement:

| | PEER min/max | PLUS min/max | PRO min/max |
|---|---|---|---|
| historical-taker | 1350 / 2600 | 680 / 1300 | 165 / 320 |
| current-earn | 500 / 960 | 175 / 330 | 50 / 100 |

What `minimumMembers` actually catches: sufficiently large undercounts. It does NOT catch
distorted source composition when cardinality stays above the floor, and gives no upper-side
protection — hence `maximumMembers` and the monotonicity check. During initial seed the
removal-BPS checks are skipped for empty groups, so these bounds are the main statistical guard
at exactly the moment the most data is written.

`assertDesiredSnapshotComplete` swaps its cross-tier duplicate scan for the cascading assertion,
preserving a second independent guard at plan time.

### 2.7 Validation must be split by phase

`assertPlanSafe` originally rejected the whole plan on pre-truncation removal counts before any
execution. Left as-is, 101 planned removals — or one small group over its BPS limit — would abort
a completely safe add-only Phase B1 run, stalling the backfill on a constraint that phase cannot
violate. Split it three ways:

- **Always enforced:** desired-snapshot bounds, `MAX_PLANNED_ADDS`, the `ALLOW_INITIAL_SEED` gate.
- **Always reported, never blocking:** removal counts by scope/tier and distinct-wallet totals.
- **Enforced only before a phase that can execute removals (B2, C):** `MAX_TOTAL_REMOVALS`,
  `MAX_REMOVAL_WALLETS`, `MAX_REMOVAL_BPS_PER_GROUP`.

## Section 3 — Config, rollout, testing

**Config:** group entries gain `maximumMembers`. Group count and IDs are unchanged.

**Upstream:** `AddressGroup` / `AddressGroupMember` are generic over `groupId`, so no indexer
schema change is required.

**Migration removals are a HYPOTHESIS, not a proven property.** Cascading desired membership is a
superset of the same calculation's exclusive desired membership — that says nothing about the
DEPLOYED state. Removals can legitimately appear if production was seeded from an older snapshot,
if volume or lock-score moved since, if blocked-wallet rules changed, or if production holds
manual/stale memberships. Required before rollout: a real production `plan` producing a
removals-by-scope/tier report with reason categories and no addresses. Any migration removal is a
separate approval gate.

**Resolved during implementation:** `addMembers` and `removeMembers` are both idempotent on-chain
— `_addMember` skips an already-present member without reverting, and removal skips an absent one
(`AddressGroupRegistry.sol:253-259`). A replan against a stale indexer watermark therefore wastes
gas but is safe. `addMembers` does revert on an empty array, which the chunking never produces.

**`scripts/compare-local.ts`** keeps reading exclusive per-tier seed files and expands them into
the cascading prefix before diffing, so existing seed directories still work.

**Rollout:** no new groups are created; the six existing groups migrate from exclusive to
cascading. Pause the cron, deploy, `plan`, review `removalReasons`, `sync`, wait for the
watermark, repeat to `deferredAdds: 0`, gated repair runs if the preflight still fails, then
resume. Roughly 1,350 net adds — inside one run at the default budget. Full sequence and a
recovery runbook are in the README.

**Operability fix:** `executeMutations` accumulated `transactionHashes` and returned them only at
the end, and the runner logged them only on success — so a mid-run revert lost the record of every
transaction already mined. Each hash is now logged as its receipt confirms.

**Testing:**
- `tierForAddress` returns the HIGHEST tier — a PRO wallet must not report the floor.
- Cascading prefix property holds for every calculated snapshot; `assertCascadingSets` throws on
  a hand-built violation; the preflight detects an exclusive-style current state.
- **Deadlock regression:** after backfill completes with a failing cascade check, the run MUST
  select B2 and remove the legacy membership rather than re-selecting an add-only phase forever.
- Exclusive → cascading transitions with failure injected at every transaction boundary,
  asserting violations never increase and replanning still converges.
- Add mutations ordered bottom-up, removals top-down, regardless of `config.groups` order.
- Truncation at an arbitrary budget leaves prefix-valid states; multi-run convergence when the
  budget cuts before prerequisite adds.
- Phase B1 is not aborted by removal-limit breaches.
- One blocked PRO wallet across both scopes (6 membership removals, 1 distinct wallet); 101
  single-group removals.
- `maximumMembers` and count-monotonicity reject a distorted snapshot.
- A blocked wallet appears in no group at any tier.
