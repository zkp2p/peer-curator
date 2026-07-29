# Validation record

## Historical-only hard cut

Validated 2026-07-29 with transaction execution disabled.

- `pnpm check`: 11 test files and 76 tests passed; lint, typecheck, and build passed.
- `pnpm test:coverage`: passed with 72.5% statement coverage.
- `pnpm check:upstream`: contracts, historical `TakerStats`, current membership projection,
  handler, and both registry bindings are compatible.
- Live preproduction-indexer calculation returned only `historical-taker`: 10,106 source rows;
  1,715 Peer, 855 Plus, and 210 Pro cumulative memberships.
- The same preproduction indexer returned all three production `AddressGroup`
  rows from registry `0x39F80118f9eB619135f116171b6Cb91D372C5AF2`,
  with indexed member counts of 1,715 Peer, 855 Plus, and 210 Pro.
- No Current-Earn aggregate was queried or calculated.

## Prior validation

Validated 2026-07-24 with transaction execution disabled.

## Production calculation

Inputs:

- Production indexer through both authenticated and public access paths.
- Twenty-five committed blocked-wallet hashes; no Curator/database request.
- No address-specific tier overrides.

Results:

| Scope | Source rows | Peer | Plus | Pro | Total |
|---|---:|---:|---:|---:|---:|
| Historical taker, recalculated against current lifetime stats | 9,998 | 854 | 635 | 210 | 1,699 |

The API-key and paced public modes produced identical membership counts. The
keyed mode sent `x-api-key`; the public mode omitted it and enforced a local
650 ms request interval.

The calculation was rerun after the indexer-backed membership refactor and
returned the same source rows and all three tier counts.

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
pnpm calculate
pnpm verify -- 0x...
pnpm compare:local -- /path/to/group-seeds
Node 22 local: typecheck, 22 tests, coverage, build
```

`pnpm check:upstream` confirms the latest contracts bytes32 ABI, current
membership schema and handler, and both staging and production registry source
bindings.

No production on-chain plan or transaction execution was performed as part of
this read-only manifest validation. The current-membership consumer path is
covered by mocked GraphQL tests for group coverage, bytes32 IDs, member
enumeration, and `memberCount` parity. Snapshot tests cover a stable lagged
watermark, indexer movement during reads, and insufficient RPC confirmations.
