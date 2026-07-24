# Peer Curator

Calculates and maintains two three-tier, exact-membership policy families in
`AddressGroupRegistry`:

- `historical-taker`: the pre-Earn taker-volume tiers.
- `current-earn`: the frozen Earn qualification tiers.

The service pulls production indexer aggregates, excludes wallets whose
address hashes are in the committed denylist, calculates desired membership,
reconstructs current registry membership from events, and submits the minimal
add/remove transaction batches.

## High-level tiers

The public groups are:

- **Peer** — established participation.
- **Plus** — higher-volume participation.
- **Pro** — the highest public cohort.

Starting volume bands before lock-score penalties:

| Scope | Peer | Plus | Pro | Lock-score thresholds |
|---|---:|---:|---:|---|
| Historical taker | $500 | $2,000 | $10,000+ | 50 / 200 / 500 / 1,000 |
| Current Earn | $1,000 | $10,000 | $50,000+ | 100 / 400 / 1,000 / 2,000 |

Historical volume is `TakerStats.totalFulfilledVolume`. Current Earn volume is:

```text
sum(MakerPlatformStats.totalAmountTakenPreEarnCutover)
+ MakerPeerPayStats.ppTakenPostEarnCutover
```

Both policies dilute `lockScore` by
`max(TakerStats.totalFulfilledVolume, 250 USDC)` and demote one tier per crossed
threshold. The former President override set is also committed as address
hashes; all three entries map to Pro. The preserved legacy calculation has an
additional internal top band so lock-score demotions remain faithful, but that
band is folded into the public Pro group.

## Static blocked-wallet snapshot

`src/staticWalletRules.ts` contains the 25 blocked wallets from Curator
production as `keccak256` hashes of their normalized 20-byte addresses. The
blocked-wallet check never calls Curator; only the tier aggregates come from
the indexer. Given a wallet, any operator can hash it locally and reproduce
the inclusion/exclusion decision.

The snapshot date and count are documented beside the constants. Updating it
is a reviewed source change: independently obtain the approved blocked-wallet
set, normalize and hash each address, replace the constants, run the local
comparison, and review the diff before deployment.

`pnpm hash-wallets -- /path/to/wallets.txt` converts a newline-delimited or
JSON source file to sorted hashes without printing the source wallets.

## Safety model

- Exact-tier groups: a member belongs to one tier per policy family.
- Current on-chain state comes from replaying `MemberAdded` and `MemberRemoved`
  from the configured registry deployment block.
- Indexer or RPC failures stop the run.
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
git clone git@github.com:zkp2p/peer-curator.git
cd peer-curator
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

`calculate` and `verify` work against the public production indexer without
secrets or a group configuration:

```bash
pnpm calculate
pnpm verify -- 0xYourWallet
```

When `INDEXER_API_KEY` is present, requests include it as `x-api-key` and use
the proxy's higher keyed quota. When it is absent, the client automatically
uses public access and paces requests below the 100 requests/minute public
limit. Public runs are therefore slower but produce the same result.

Provide the optional key either in `.env`:

```text
INDEXER_API_KEY=your-key
```

or in the current shell:

```bash
export INDEXER_API_KEY=your-key
pnpm calculate
```

For `plan` or `sync`, copy `config/groups.example.json` to the untracked
`config/groups.json`, then set the real registry address, deployment block,
and six group IDs. Group names are event-only in the contract, so this file
is the durable `(chainId, registryAddress, groupId)` manifest.

Runtime credentials:

- `INDEXER_API_KEY` — optional; public indexer access is rate-limited.
- `RPC_URL` — required for `plan` and `sync`.
- `GROUP_ADMIN_PRIVATE_KEY` — required only for execution.

The private key must resolve to the owner returned by `getGroup` for every
configured group.

## Commands

```bash
pnpm calculate
pnpm verify -- 0xYourWallet
pnpm compare:local -- /path/to/group-seeds
pnpm hash-wallets -- /path/to/wallets.txt
pnpm plan
pnpm sync
pnpm check
pnpm check:upstream
```

## Why membership is reconstructed from events

`AddressGroupRegistry.members(groupId, wallet)` answers whether one known
wallet is a member, but the contract does not expose a function that lists
every member. A reconciler needs that full current set so it can remove stale
wallets as well as add missing ones.

The service scans `MemberAdded` and `MemberRemoved` logs from the registry
deployment block, sorts them by block and log position, and applies them in
order:

```text
MemberAdded(group, wallet)   -> add wallet to the local set
MemberRemoved(group, wallet) -> remove wallet from the local set
```

The resulting set is the current on-chain membership reconstructed from the
chain's append-only history. `GroupCreated` logs and `getGroup` reads
separately verify that each configured group exists and has the expected
governance.

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

The Docker image executes one `sync` run and exits. `railway.json` configures
one run every 24 hours at midnight UTC:

```text
0 0 * * *
```

Keep `EXECUTE=false` until staging validation and an explicit production
approval. Railway/Infisical setup and production deployment are separate
operations; this repository does not create or rotate secrets.

## Known upstream drift

The current production indexer supports the exact preserved formulas. Latest
indexer `main` has intentionally removed their aggregate fields. See
[docs/compatibility.md](docs/compatibility.md). The service fails closed if
that incompatible schema reaches its configured endpoint.
