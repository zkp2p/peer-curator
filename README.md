# Peer Curator

Calculates and maintains two three-tier, exact-membership policy families in
`AddressGroupRegistry`:

- `historical-taker`: the pre-Earn taker-volume tiers.
- `current-earn`: the frozen Earn qualification tiers.

The service pulls production indexer aggregates, excludes wallets whose
address hashes are in the committed denylist, calculates desired membership,
reads current registry membership from the indexer's canonical
`AddressGroupMember` projection, and submits the minimal add/remove transaction
batches.

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
threshold. The preserved legacy calculation has an additional internal top
band so lock-score demotions remain faithful, but that band is folded into the
public Pro group. There are no address-specific tier overrides.

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
- Current curated state comes from `AddressGroup` and `AddressGroupMember`.
- The indexer watermark is captured before any aggregate or membership read and
  must remain unchanged through the final read.
- That watermark must be at least `SNAPSHOT_CONFIRMATIONS` behind the RPC head;
  a fresh, unconfirmed indexer tip is never used.
- Every configured group must exist, and its indexed `memberCount` must equal
  the enumerated member rows.
- Indexer or RPC failures stop the run.
- Missing GraphQL fields stop the run.
- Nonexistent groups, unexpected resolvers, or a signer that is not the group
  curator stop execution.
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
and six bytes32 group IDs. Group names are event-only in the contract, so this
file is the durable `(chainId, registryAddress, groupId)` manifest.

Runtime credentials:

- `INDEXER_API_KEY` — optional; public indexer access is rate-limited.
- `RPC_URL` — required for `plan` and `sync`.
- `GROUP_ADMIN_PRIVATE_KEY` — required only for execution.

`SNAPSHOT_CONFIRMATIONS` is the minimum RPC confirmation depth required for
the indexer's stable processed-block watermark. The reconciler uses that
watermark as the snapshot; it does not require the indexer to catch up to the
RPC head.

The private key must resolve to the curator returned by `getGroup` for every
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

## Indexer-backed current membership

`AddressGroupRegistry.members(groupId, wallet)` answers whether one known
wallet is curated, but the contract does not enumerate all members. The
indexer's `AddressGroupMember` entity is that canonical enumerable current
set; a row is created on `MemberAdded` and deleted on `MemberRemoved`.

For `plan` and `sync`, the service:

1. Captures `chain_metadata.latest_processed_block`.
2. Reads all desired-tier aggregates, the six `AddressGroup` rows, and every
   matching `AddressGroupMember` row.
3. Reads the watermark again and requires it to be unchanged, preventing a
   reconciliation across two indexer states as far as the Envio/Hasura query
   surface allows.
4. Requires the pinned watermark not to be ahead of the RPC head. A nonzero
   `SNAPSHOT_CONFIRMATIONS` can additionally require an indexer deployment
   that deliberately trails the chain; continuously synced deployments should
   leave it at `0`.
5. Reads bytecode and `getGroup` governance at that exact block.

The indexer surface is a hard dependency. Missing group rows, a member-count
mismatch, a changed watermark, insufficient confirmations, or an unavailable
field stops the run before a transaction can be built. There is no RPC-log
fallback.

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

The Docker image executes one command and exits. `RUN_COMMAND` selects
`calculate`, `verify`, `plan`, or `sync`; it defaults to `calculate`.
`railway.json` configures one run every 12 hours, at midnight and noon UTC:

```text
0 */12 * * *
```

If the indexer advances while the desired aggregates and group membership are
being read, the run remains fail-closed and retries the read-only snapshot
phase up to `SNAPSHOT_MAX_ATTEMPTS` times. `SNAPSHOT_RETRY_DELAY_MS` controls
the delay between attempts. Transactions are considered only after one
unchanged, sufficiently confirmed snapshot has been captured.

New environments should start with `RUN_COMMAND=calculate` and `EXECUTE=false`.
This mode needs only the indexer and can run before the registry groups,
membership projection, and group-curator signer are ready.

After all six group IDs are recorded and the membership projection is
deployed and backfilled, move through `plan` before selecting `sync`. Keep
`EXECUTE=false` until the generated plan is approved; `sync` only sends
transactions when `EXECUTE=true`.

The hosted environments are:

- `staging` — staging indexer and registry/group manifest.
- `production` — production indexer and registry/group manifest.

Each environment must use its matching indexer, registry deployment, group
IDs, and signer. Never point one environment at the other environment's
contracts or indexer.

## Known upstream drift

The service requires the preserved tier aggregates plus `AddressGroup`,
`AddressGroupMember`, `chain_metadata`, and an environment-specific nonzero
registry binding. See [docs/compatibility.md](docs/compatibility.md).
`pnpm check:upstream` fails if a required contract, schema, handler, or source
binding is absent.
