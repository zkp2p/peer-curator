# Validation record

Validated 2026-07-24 with transaction execution disabled.

## Production calculation

Inputs:

- Production indexer through `x-api-key`.
- Curator production Supabase `BlockedWallet` through a read-only transaction.
- Three legacy Platinum overrides supplied in memory; no wallet list persisted.

Results:

| Scope | Source rows | Peer | Plus | Pro | Platinum | Total |
|---|---:|---:|---:|---:|---:|---:|
| Historical taker, recalculated against current lifetime stats | 9,997 | 854 | 635 | 135 | 75 | 1,699 |
| Frozen current Earn | 2,704 aggregate rows | 419 | 155 | 26 | 39 | 639 |

The blocklist contained 25 wallets. No credentials or member addresses were
written or logged.

The historical counts are expected to exceed the June 18 seed snapshot because
this service continuously recalculates against current lifetime taker activity.

## Commands

Passed:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm check:upstream
Node 22: typecheck, 11 tests, build
```

`pnpm check:upstream` confirms current production compatibility and reports the
known forward incompatibility in indexer `main`.

No on-chain plan was run because a production registry deployment and the eight
group IDs are not present in the current contracts deployment registry.
