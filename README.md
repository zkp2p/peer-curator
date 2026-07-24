# ZKP2P taker groups

Maintains two four-tier, exact-membership policy families in
`AddressGroupRegistry`:

- `historical-taker`: the pre-Earn taker-volume tiers.
- `current-earn`: the frozen Earn qualification tiers.

The service pulls authenticated production indexer aggregates, removes every
wallet in Curator's production `BlockedWallet` table, calculates desired
membership, reconstructs current registry membership from events, and submits
the minimal add/remove transaction batches.

## Tier policies

| Scope | Peer | Plus | Pro | Platinum | Lock-score thresholds |
|---|---:|---:|---:|---:|---|
| Historical taker | $500 | $2,000 | $10,000 | $25,000 | 50 / 200 / 500 / 1,000 |
| Current Earn | $1,000 | $10,000 | $50,000 | $100,000 | 100 / 400 / 1,000 / 2,000 |

Historical volume is `TakerStats.totalFulfilledVolume`. Current Earn volume is:

```text
sum(MakerPlatformStats.totalAmountTakenPreEarnCutover)
+ MakerPeerPayStats.ppTakenPostEarnCutover
```

Both policies dilute `lockScore` by
`max(TakerStats.totalFulfilledVolume, 250 USDC)` and demote one tier per crossed
threshold. `LEGACY_PLATINUM_OVERRIDES` preserves the former President override
set without committing wallet identifiers.

## Safety model

- Exact-tier groups: a member belongs to one tier per policy family.
- Current on-chain state comes from replaying `MemberAdded` and `MemberRemoved`
  from the configured registry deployment block.
- Indexer, database, or RPC failures stop the run.
- Missing GraphQL fields stop the run.
- Nonexistent groups, unexpected resolvers, or a signer that is not the group
  owner stop execution.
- Adds are simulated and mined before any removals.
- Global add/remove limits, per-group removal percentages, minimum group sizes,
  and an initial-seed gate bound every run.
- `calculate` and `plan` never send transactions.
- `sync` sends transactions only with `EXECUTE=true`.
- Member addresses and credentials are not logged.

## Setup

Requires Node 22 and pnpm.

```bash
corepack enable
pnpm install --frozen-lockfile
cp config/groups.example.json config/groups.json
cp .env.example .env
```

Set the real registry address, deployment block, and eight group IDs in the
untracked `config/groups.json`. Group names are event-only in the contract, so
this file is the durable `(chainId, registryAddress, groupId)` manifest.

Required secrets:

- `INDEXER_API_KEY`
- `CURATOR_DATABASE_URL` — use a read-only production role.
- `RPC_URL`
- `GROUP_ADMIN_PRIVATE_KEY` — required only for execution.

The private key must resolve to the owner returned by `getGroup` for every
configured group.

## Commands

```bash
pnpm calculate
pnpm plan
pnpm sync
pnpm check
pnpm check:upstream
```

Recommended rollout:

1. Run `calculate` and compare counts with the approved seed manifest.
2. Run `plan` against staging.
3. Initial staging seed: set `ALLOW_INITIAL_SEED=true`, keep `EXECUTE=false`,
   and inspect the plan.
4. Set `EXECUTE=true` only for the approved run.
5. Return `ALLOW_INITIAL_SEED=false` immediately after seeding.
6. Repeat the same gated process for production after the registry and group
   IDs exist.

## Cron deployment

The Docker image executes one `sync` run and exits. Configure a single Railway
cron service with the desired schedule, for example every 15 minutes:

```text
*/15 * * * *
```

Keep `EXECUTE=false` until staging validation and an explicit production
approval. Railway/Infisical setup and production deployment are separate
operations; this repository does not create or rotate secrets.

## Known upstream drift

The current production indexer supports the exact preserved formulas. Latest
indexer `main` has intentionally removed their aggregate fields. See
[docs/compatibility.md](docs/compatibility.md). The service fails closed if
that incompatible schema reaches its configured endpoint.
