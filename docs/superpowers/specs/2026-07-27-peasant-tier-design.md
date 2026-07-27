# Design: PEASANT as a fourth public tier (zkp2p/peer-curator)

Status: implemented on `feat/peasant-tier`, not merged.
Reviewed via Claude + Codex convergence, 3 rounds, converged, as part of the combined design.
Production measurements taken 2026-07-27 against the live Base indexer.

**Builds on [2026-07-27-cascading-tiers-design.md](./2026-07-27-cascading-tiers-design.md),
which is merged.** That document specifies cascading membership and the migration machinery —
the phase model, mutation ordering, snapshot bounds, removal-reason reporting. None of it is
repeated here. This document covers only what adding a fourth tier changes on top.

Both were designed as one change and implemented together; the split came afterwards. The
combined build log is in `docs/superpowers/plans/2026-07-27-peasant-cascading-tiers.md`, which
describes the eight-group end state and is kept as the record of how it was built.

## What changes

`PEASANT` currently exists as the computed band meaning "not curated" — a sentinel returned by
`tierForAddress` for any wallet in no group. This change promotes it to a real curated group in
both scopes, taking the count from six to eight.

## Decisions taken

1. **PEASANT becomes a real public group, in BOTH scopes** → 8 groups total. Keeps
   `POLICY_SCOPES × TIERS` a clean product, so coverage validation, the cascade assertion and
   the plan builder need no special cases.
2. **PEASANT is the full complement**: every wallet with a source row that does not reach PEER,
   **including wallets with exactly zero volume**. No dust floor. "If the indexer knows you,
   you're curated."
3. It is the **floor of each scope's cascade**, so every curated wallet in that scope belongs to
   it. `historical-taker:PEER ⊆ historical-taker:PEASANT` and likewise for Earn.

## Measured production data (2026-07-27)

| Group | historical-taker | current-earn |
|---|---:|---:|
| **PEASANT (everyone)** | **10,061** | **1,797** |
| PEER | 1,712 | 638 |
| PLUS | 856 | 219 |
| PRO | 211 | 65 |

Post-denylist, from a live `pnpm calculate`: 10,041 / 1,703 / 849 / 210 and
1,797 / 638 / 219 / 65.

Total memberships rise from 3,684 (cascading, six groups) to **15,559**. Of the historical
PEASANT population, 4,807 wallets have exactly zero fulfilled volume and 63 more are under $1 —
58% never transacted. That is intended per decision 2.

**The two PEASANT groups are not redundant.** Only 648 wallets appear in both scopes; 1,149 Earn
candidates have no `TakerStats` row at all, and 9,413 takers never made. Neither set contains the
other. A single shared floor would be viable — the union is a superset of both scopes' PEER
groups, so the cascade invariant would still hold — but it would break the scope × tier product
and couple the two scopes, for a ~5% saving in write volume.

## Tier model changes

`src/domain.ts`:
- `TIERS` gains `PEASANT` at index 0. Ordering was already load-bearing from the cascading
  change; this extends the ladder downward.
- `PEASANT` stops being the "not in any group" sentinel, since it now names a real group. That
  sentinel becomes `NO_TIER = "NONE"`, and `tierForAddress` returns `Tier | "NONE"`.
- `NONE` still occurs: denylisted wallets, and wallets absent from a scope's source rows — a
  taker with no maker stats is not a `current-earn` candidate at all.
- `emptyTierSets()` and `tierCounts()` gain a PEASANT key.

`src/policies.ts`:
- `addMember` loses its `if (tier === "PEASANT") return;` early return. The `Math.max(0, ...)`
  clamp in `classifyTier` already guarantees no computed tier falls below the floor, so every
  non-blocked candidate now lands in at least one group and no early-return case remains.
- `classifyTier`, `TIER_ORDER` and the threshold constants are unchanged. `PEASANT` still has no
  threshold — it is the floor, and `ThresholdTier` continues to exclude it.

## Config and bounds

- `groupFileSchema` `.length(6)` → `.length(8)`. The tier enum derives from `TIERS`, so it picks
  up PEASANT automatically, as does `validateGroupCoverage`'s scope × tier loop.
- `config/groups.example.json` gains two entries.

Bounds for the new groups, at ~80% and ~150% of the 2026-07-27 measurement:

| | PEASANT min/max |
|---|---|
| historical-taker | 8000 / 15000 |
| current-earn | 1400 / 2700 |

The other six groups keep the bounds set by the cascading change.

## Consequences for rollout

- **Two groups must be created on-chain first**, `isPublic == false` with the curator equal to
  the signer, and indexed before the manifest is updated. The cascading migration created none.
- **Code and config are not independently rollback-compatible**: the six-group binary rejects an
  eight-entry manifest at startup, so a rollback must revert both together.
- **Seeding is no longer a single run.** ~15,559 memberships is roughly six runs at the default
  `MAX_EXECUTED_ADDS_PER_RUN=3000`, versus one for the cascading migration alone.
- `MAX_REMOVAL_WALLETS` gets tighter in effect: one denylisted PRO wallet now produces four
  removals per scope rather than three.

## Testing

Beyond the cascading suite, which applies unchanged:

- Every classified wallet lands in PEASANT, **including zero-volume rows**.
- A lock-score demoted wallet cascades correctly at its reduced tier.
- A blocked wallet appears in no group **at any tier, including the PEASANT floor**.
- `tierForAddress` returns `NONE`, not `PEASANT`, for a wallet in no group.
- Config rejects a six-group manifest and requires bounds on all eight entries.
- The migration regression, phase selection and batch-boundary tests are re-derived for the
  four-tier ladder — `groupId(1..4)` is historical-taker PEASANT/PEER/PLUS/PRO and `groupId(5..8)`
  is current-earn, so every hardcoded group index shifts.
