# Validation record

Validated 2026-07-24 with transaction execution disabled.

## Production calculation

Inputs:

- Production indexer through both authenticated and public access paths.
- Twenty-five committed blocked-wallet hashes; no Curator/database request.
- Three committed legacy top-tier override hashes, folded into Pro.

Results:

| Scope | Source rows | Peer | Plus | Pro | Total |
|---|---:|---:|---:|---:|---:|
| Historical taker, recalculated against current lifetime stats | 9,998 | 854 | 635 | 210 | 1,699 |
| Frozen current Earn | 2,704 aggregate rows | 419 | 155 | 65 | 639 |

The API-key and paced public modes produced identical membership counts. The
keyed mode sent `x-api-key`; the public mode omitted it and enforced a local
650 ms request interval.

The blocklist contains 25 wallet hashes. A positive lookup was checked against
the source snapshot without logging or persisting the wallet. No credential or
member address was written or logged.

The historical counts are expected to exceed the June 18 seed snapshot because
this service continuously recalculates against current lifetime taker activity.

## Local seed comparison

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

## Commands

Passed:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm check:upstream
pnpm calculate
pnpm verify -- 0x...
pnpm compare:local -- /path/to/group-seeds
Node 22 CI: typecheck, 14 tests, build
```

`pnpm check:upstream` confirms current production compatibility and reports the
known forward incompatibility in indexer `main`.

No on-chain plan was run because a production registry deployment and the six
group IDs are not present in the current contracts deployment registry.
