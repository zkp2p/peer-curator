# Validation record

## Chargeback-only historical taker policy

Live read-only baselines captured on 2026-07-30 with transaction execution
disabled and no wallet addresses logged.

The legacy production calculation reproduced the expected cumulative
membership counts of 1,717 Peer, 860 Plus, and 210 Pro from 10,132
`TakerStats` rows. The chargeback-only calculation read 4,443 PayPal, Venmo,
and Cash App `TakerPlatformStats` rows across 3,894 wallets and produced:

| Environment | Qualifying platform rows | Peer | Plus | Pro | Total memberships |
|---|---:|---:|---:|---:|---:|
| Production | 4,443 | 451 | 246 | 81 | 778 |
| Staging | 13 | 0 | 0 | 0 | 0 |

The production change from the legacy baseline is intentional and matches the
prior chargeback-volume evidence exactly. Staging indexes its own staging
contract history rather than production history; its 29 total takers include
10 wallets on chargebackable platforms, none above the $500 entry threshold.

The policy:

- consumes the canonical PayPal, Venmo, and Cash App hashes from
  `@zkp2p/contracts-v2/paymentMethods/lookups.json`;
- cross-checks those mappings against their canonical keccak hashes and reverse
  lookups at startup;
- paginates `TakerPlatformStats` by stable `id`, rejects duplicates and
  malformed rows, and sums multiple qualifying platform rows once per wallet;
- gives all other platforms zero qualification volume;
- applies the 25-entry committed blocked-wallet hash snapshot;
- preserves `Pro ⊆ Plus ⊆ Peer`;
- does not select `TakerStats.totalFulfilledVolume`, cancellation volume, or
  lock-score data;
- does not calculate Current-Earn tiers or apply address-specific overrides.

## Required commands

Run before PR handoff:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
WORKSPACE_ROOT=/path/to/workspace pnpm check:upstream
INDEXER_GRAPHQL_URL=<staging> pnpm calculate
INDEXER_GRAPHQL_URL=<production> pnpm calculate
git diff --check
```

The membership path remains independently fail-closed: every configured
`AddressGroup` must exist, its `memberCount` must equal the fully enumerated
`AddressGroupMember` rows, the indexer watermark must remain pinned through
the read, and RPC governance must match before a transaction can be planned.
