# Peer Curator

Calculates and maintains the three-tier, cascading `historical-taker` policy
family in `AddressGroupRegistry`. Current-Earn tiers are intentionally not
calculated or reconciled.

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

**Group membership is cascading, not exclusive.** A Pro wallet is also written into Plus and
Peer, so a consumer asking "is this wallet Peer or better?" makes a single
`members(peerGroupId, wallet)` call rather than OR-ing across groups. Higher tiers always carry
lower-tier access.

The volume bands below are therefore entry *floors*, not band populations. Crossing $2,000 of
historical volume adds a wallet to Plus while it remains in Peer.

| Scope | Peer | Plus | Pro | Lock-score thresholds |
|---|---:|---:|---:|---|
| Historical taker | $500 | $2,000 | $10,000+ | 50 / 200 / 500 / 1,000 |

Because membership is cumulative, a promotion is adds-only — a wallet crossing a threshold is
added to the higher group and stays in the lower ones. Removals happen only on lock-score
demotion or denylisting.

## Public means readable, not self-service

All three groups are created with `isPublic == false` and a curator equal to the signer.

"Public" in this project means publicly *readable* — any contract or service can call
`members(groupId, wallet)`. It is not the registry's `isPublic` flag, which permits self-service
membership and would let anyone add themselves. `assertRegistryGovernance` rejects any
configured group with `isPublic == true`; do not weaken that check.

Historical volume is `TakerStats.totalFulfilledVolume`. The policy dilutes `lockScore` by
`max(TakerStats.totalFulfilledVolume, 250 USDC)` and demotes one tier per crossed
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

## Test-environment pinned members

`PINNED_MEMBERS_JSON` optionally adds reviewed test wallets to the desired
snapshot. It is empty by default and should remain empty in production. Each
entry identifies one policy scope, the highest tier to grant, and a wallet:

```json
[
  {
    "scope": "historical-taker",
    "tier": "PRO",
    "address": "0x0000000000000000000000000000000000000001"
  }
]
```

Pins use the same cascading semantics as calculated membership, so a pinned
Pro wallet is also desired in Plus and Peer. A blocked wallet cannot be pinned.
The service logs only the number of configured pins, never their addresses.
Removing a pin returns that wallet to the calculated policy on the next sync.

## Safety model

- Cascading groups: a member of a tier belongs to every lower tier in the same policy family.
  `assertCascadingSets` enforces this on every calculated snapshot.
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
- Adds are simulated and mined before any removals, and within each direction they are ordered
  by tier: adds lowest-first, removals highest-first. **Once the on-chain state is cascading,**
  interrupting a run therefore leaves every wallet holding a valid cascade prefix — under-granted
  at worst, never incoherent. That guarantee does not hold during migration, which by definition
  starts from a non-cascading state: a legacy PRO-only wallet gaining its PEER add is briefly
  `{PEER, PRO}`, still missing PLUS. What holds throughout migration is weaker but sufficient —
  mutations never introduce a new violation, and each run converges toward the desired prefix.
- Each transaction hash is logged as its receipt confirms, so a mid-run revert still leaves a
  complete record of what was mined.
- Global add/remove limits, per-group removal percentages, group size bounds, and an
  initial-seed gate bound every run.
- `calculate` and `plan` never send transactions.
- `sync` sends transactions only with `EXECUTE=true`.
- Member addresses and credentials are not logged. Removal reports are counts and categories
  only.

### Run phases

The deployed groups were exclusive, so the reconciler cannot assume the cascade invariant its
ordering rules depend on. It derives a phase from the plan on every run:

| `deferredAdds` | cascade check | phase | behaviour |
|---|---|---|---|
| `> 0` | either | `BACKFILL` | adds only, no removals execute |
| `== 0` | fails | `MIGRATION_REPAIR` | removals permitted, requires `ALLOW_MIGRATION_REMOVALS=true` |
| `== 0` | passes | `NORMAL` | full reconciliation with all destructive limits |

Phase is derived, never operator-managed, so it cannot be left in the wrong position by a human
or a crashed process. `MIGRATION_REPAIR` is a distinct phase rather than part of backfill
because a legacy high-tier membership is only repairable *by* a removal — a model that forbade
removals whenever the cascade check failed would deadlock.

Removal limits (`MAX_TOTAL_REMOVALS`, `MAX_REMOVAL_WALLETS`, `MAX_REMOVAL_BPS_PER_GROUP`) are
enforced only before phases that can execute removals, so a pending removal spike cannot stall
a safe add-only backfill.

`MAX_REMOVAL_WALLETS` exists because the other removal limits count memberships, not people:
under cascading, one denylisted Pro wallet produces three removals per scope.

`MAX_PLANNED_ADDS` is a hard abort ceiling; `MAX_EXECUTED_ADDS_PER_RUN` is a soft per-run budget
that truncates and defers the remainder. Planned-add count depends on current chain state, so
the real guard against a bad calculation is `minimumMembers`/`maximumMembers` on the desired
snapshot, which is state-free.

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
and three bytes32 group IDs. Group names are event-only in the contract, so this
file is the durable `(chainId, registryAddress, groupId)` manifest.

Each group also carries `minimumMembers` and `maximumMembers`. These bound the *calculated*
count, not the on-chain count, so they catch a truncated or distorted indexer result before any
transaction is built. The shipped example values bracket the counts measured on 2026-07-27;
re-derive them if the population shifts materially.

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
2. Reads all desired-tier aggregates, the three `AddressGroup` rows, and every
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

1. Create the three historical-taker groups with the execution signer as curator, `isPublic=false`,
   and a zero resolver.
2. Confirm the indexer has an `AddressGroup` row and complete membership projection for all three
   groups.
3. **Pause the cron.** Initial seed and migration runs are manual and observed.
4. Deploy the code with the three-entry `config/groups.json`.
5. Run `plan`. Review the `removalReasons` report; if it is non-empty, get that approved
   separately before proceeding. Cascading membership is a superset of exclusive membership, so
   the change to cascading does not by itself imply any removal. Removals can still legitimately
   arise where the deployed state has diverged from current desired membership — lock-score
   demotions since the last sync, denylist additions, a seed taken from an older snapshot, or
   manual registry edits. `removalReasons` categorises them; every one still needs review.
6. For an empty registry, set `ALLOW_INITIAL_SEED=true` only for the approved first `sync` with
   `EXECUTE=true`, then return it to `false`.
7. After each run, wait until the indexer watermark covers the last mined transaction's block
   before replanning.
8. Repeat until `plan` reports `deferredAdds: 0`.
9. If the cascade preflight still fails, the run selects `MIGRATION_REPAIR`. Review the removals,
   set `ALLOW_MIGRATION_REMOVALS=true` for that run only, and return it to `false` immediately
   after. Repeat until `cascadeViolations` is empty.

   `ALLOW_MIGRATION_REMOVALS` authorises the phase; it does not lift the removal limits.
   `MAX_TOTAL_REMOVALS` (100), `MAX_REMOVAL_WALLETS` (50) and `MAX_REMOVAL_BPS_PER_GROUP` (500)
   still abort the run independently. If a legitimate migration exceeds them, raise the specific
   limit for that run rather than reaching for a larger blanket increase — the plan log reports
   `totalRemovals` and `removalWalletCount` so you can tell which one is binding.
10. Confirm `plan` reports `phase: NORMAL`, then resume the cron.

The historical policy produced 2,780 cumulative memberships in the latest validation, inside one
run at the default `MAX_EXECUTED_ADDS_PER_RUN=3000`. Measure the real diff rather than trusting
that estimate.

## Recovery

`addMembers` and `removeMembers` are both idempotent on-chain — an already-present member is
skipped without reverting, and so is an absent one on removal. Re-running is therefore always
safe; the worst case is wasted gas.

**Failed batch mid-run.** The run throws on the first reverted transaction and stops; no later
batch is submitted. Every transaction already mined was logged individually as
`Registry transaction mined`. Rerun `plan` — the reconciler diffs against current state, so
completed batches are not repeated.

**Stale indexer.** Symptom: `plan` proposes adds for members already on-chain. The watermark has
not caught up to the mined receipts. Check `indexedThroughBlock` against the block of the last
logged transaction and wait. Rerunning early is safe but wastes gas.

**Signer or RPC failure.** A transaction may have been submitted without a receipt being
observed. Check the last `Registry transaction mined` line, confirm on-chain whether the next
batch landed, then rerun.

**Code rollback after this hard cut.** The previous binary requires six groups and calculates
Current-Earn membership. Do not resume it in `sync` mode. Keep execution disabled until the
historical-only code is restored or a broader policy rollback is explicitly reviewed.

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

After all three group IDs are recorded and the membership projection is
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

The service requires `TakerStats` plus `AddressGroup`,
`AddressGroupMember`, `chain_metadata`, and an environment-specific nonzero
registry binding. See [docs/compatibility.md](docs/compatibility.md).
`pnpm check:upstream` fails if a required contract, schema, handler, or source
binding is absent.
