# Validation record

## Historical record — pre-cascading, pre-PEASANT (2026-07-24)

Everything in this section was validated against the **exclusive three-tier** model, before
cascading membership and before PEASANT became a real group. Read it as history, not as evidence
about current behaviour. Two things read differently now:

- Its tier counts are **exclusive band populations**. Current counts are **cumulative** — a PRO
  wallet is counted in PLUS, PEER and PEASANT too.
- "Demoted to Peasant" meant *excluded from every group*. PEASANT is now a real group, so the
  same phrase would today mean those wallets are curated members of it.

Validated 2026-07-24 with transaction execution disabled.

### Production calculation

Inputs:

- Production indexer through both authenticated and public access paths.
- Twenty-five committed blocked-wallet hashes; no Curator/database request.
- No address-specific tier overrides.

Results:

| Scope | Source rows | Peer | Plus | Pro | Total |
|---|---:|---:|---:|---:|---:|
| Historical taker, recalculated against current lifetime stats | 9,998 | 854 | 635 | 210 | 1,699 |
| Frozen current Earn | 2,704 aggregate rows | 419 | 155 | 65 | 639 |

The API-key and paced public modes produced identical membership counts. The
keyed mode sent `x-api-key`; the public mode omitted it and enforced a local
650 ms request interval.

The calculation was rerun after the indexer-backed membership refactor and
returned the same source rows and all six tier counts.

The blocklist contains 25 wallet hashes. A positive lookup was checked against
the source snapshot without logging or persisting the wallet. No credential or
member address was written or logged.

The historical counts are expected to exceed the June 18 seed snapshot because
this service continuously recalculates against current lifetime taker activity.

### Local seed comparison

`pnpm compare:local` compared the current calculation with the earlier
`group-seeds` artifacts without printing member addresses.

| Scope | Local | Current | Overlap | Current only | Local only |
|---|---:|---:|---:|---:|---:|
| Historical taker | 1,596 | 1,699 | 1,589 | 110 | 7 |
| Current Earn | 639 | 639 | 639 | 0 | 0 |

Current Earn matches exactly, including every tier: 419 Peer, 155 Plus, and 65
Pro.

All seven historical local-only wallets still have current TakerStats rows and
are not blocked. Their current lock-score penalty demotes them to Peasant.
Among the 1,589 overlapping wallets, 45 changed exact tier as lifetime activity
and lock score evolved. The remaining current-only growth is expected because
the local historical artifact was a 2026-06-18 snapshot.

### Commands

Passed:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm calculate
pnpm verify -- 0x...
pnpm compare:local -- /path/to/group-seeds
Node 22 local: typecheck, 22 tests, coverage, build
```

`pnpm check:upstream` confirms the latest contracts bytes32 ABI, current
membership schema and handler, and the staging registry source binding. It
currently exits nonzero for two explicit rollout gates: the tier aggregate
surface is not yet restored on indexer `main`, and production has no nonzero
registry source binding.

No production on-chain plan was run because its registry and six group IDs are
not deployed. The current-membership consumer path is covered by mocked
GraphQL tests for group coverage, bytes32 IDs, member enumeration, and
`memberCount` parity. Snapshot tests cover a stable lagged watermark, indexer
movement during reads, and insufficient RPC confirmations. Staging end-to-end
parity is recorded separately after the indexer release is deployed and
backfilled.

## Current record — cascading, four tiers, eight groups (2026-07-27)

Validated on `feat/peasant-tier` with transaction execution disabled. Counts below are
**cumulative**: each tier's group contains every higher tier's members, so PEASANT is the total
curated population per scope.

`pnpm calculate` against the public production indexer:

| Scope | Source rows | Peasant | Peer | Plus | Pro |
|---|---:|---:|---:|---:|---:|
| Historical taker | 10,063 | 10,042 | 1,704 | 850 | 210 |
| Current Earn | 2,721 aggregate rows | 1,798 | 638 | 219 | 65 |

Monotonicity holds in both scopes, as `assertDesiredSnapshotBounds` requires. Every count falls
inside the configured `minimumMembers`/`maximumMembers` bounds. The 25 committed blocked-wallet
hashes are excluded from every tier including the PEASANT floor; the difference between source
rows and PEASANT is exactly those wallets that appear in the scope's source set.

`pnpm verify` on a known top-band wallet reports `PRO`, not the floor — the regression the
descending `tierForAddress` iteration exists to prevent. A wallet with taker history but no maker
stats reports `NONE` for `current-earn`, since it is not a candidate in that scope.

Passed: `pnpm check` (lint, strict typecheck, 70 tests across 10 files, build), plus
`pnpm calculate` and `pnpm verify` against the live indexer.

**No production on-chain plan has been run.** The two PEASANT group IDs are not deployed, so
`plan` and `sync` cannot execute against production until they exist. `pnpm check:upstream` is
unrelated-failing in this environment: it shells out to a sibling checkout at
`zkp2p-v2-contracts`, which is named `zkp2p-contracts` locally.
