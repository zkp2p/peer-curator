# AGENTS.md

## Scope

This repository owns the off-chain calculation and on-chain reconciliation of
Peer/Plus/Pro curated groups. It consumes production indexer aggregates,
indexed `AddressGroupRegistry` membership history, a committed hashed
blocked-wallet snapshot, and pinned registry reads.

## Safety

- Never log member addresses, indexer API keys, RPC credentials, or signing
  keys.
- Every indexer/RPC failure is fail-closed. Never reconcile a partial desired
  set or membership history.
- `calculate` and `plan` never transact.
- `sync` transacts only with `EXECUTE=true`, a matching group-owner signer, and
  all configured safety limits passing.
- Simulate every batch and wait for its successful receipt.
- Add memberships before removing old memberships.
- Production group creation, ownership transfers, signing-key rotation, and
  deployment require separate explicit approval.

## Commands

- `pnpm calculate` — calculate desired counts without RPC access.
- `pnpm verify -- 0x...` — calculate and verify one wallet without logging it.
- `pnpm compare:local -- /path/to/group-seeds` — compare counts without logging members.
- `pnpm hash-wallets -- /path/to/file` — generate sorted wallet hashes offline.
- `pnpm plan` — calculate and compare against on-chain state.
- `pnpm sync` — plan; execute only when `EXECUTE=true`.
- `pnpm check` — format/lint, typecheck, and test.
- `pnpm check:upstream` — compare required upstream surfaces with local clones.

## Producer baselines

See `docs/compatibility.md` and `docs/upstream-surface-baseline.tsv`. Treat
schema/ABI incompatibility as a blocker, not as a reason to weaken a query.
