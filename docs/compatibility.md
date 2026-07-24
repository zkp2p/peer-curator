# Producer compatibility

Baseline captured on 2026-07-24.

| Producer | Ref/commit | Surface | Status | Evidence |
|---|---|---|---|---|
| Contracts | `origin/main` / `764a125d7a859184127a36c44de3beaf5611c0d5` | `AddressGroupRegistry` reads, writes, events | Compatible | `addMembers`, `removeMembers`, `getGroup`, `MemberAdded`, and `MemberRemoved` match the embedded minimal ABI. |
| Indexer production | `origin/releases/prod` / `6aad2038e6d45d9c3202725eafb149554a3dff25` | Legacy taker and frozen Earn aggregates | Compatible | Production exposes `TakerStats.lockScore`, `MakerPlatformStats.totalAmountTakenPreEarnCutover`, and `MakerPeerPayStats.ppTakenPostEarnCutover`. |
| Indexer main | `origin/main` / `9bc2e14586b6275dd14e4b2d4e4d6262fd582691` | Legacy taker and frozen Earn aggregates | **High-severity forward incompatibility** | Main intentionally removed all three retired policy fields/entities. The runtime query will fail closed; no transaction will be sent. |
| Indexer main | `origin/main` / `9bc2e14586b6275dd14e4b2d4e4d6262fd582691` | Address-group domain projection and raw registry events | Partially compatible | `AddressGroup`, `AddressGroupMember`, and raw registry add/remove audit rows exist. Production binding is still addressless. |
| Indexer required surface | planned | Enriched append-only `AddressGroupMembershipEvent` | **Required before plan/sync** | The consumer requires explicit chain, registry, group, member, presence, block, and log fields. Raw audit rows are deliberately not parsed. |
| Curator history | pre-Earn tier implementation and 2026-07-24 production snapshot | Tier policy and blocked wallets | Provenance only | This repository owns the preserved formulas and the hashed blocked-wallet snapshot. There is no Curator runtime dependency. |

`calculate` and `verify` are compatible with production today. `plan` and
`sync` additionally require the enriched membership-event projection, a
registry source configured from its deployment block, and a complete backfill.
They fail closed until those prerequisites are present.

Before promoting the current indexer `main`, choose one of:

1. Retain the four aggregate fields/entities as a supported operational
   surface.
2. Add a replacement indexer query with equivalent frozen-volume and
   lock-score semantics.
3. Migrate this service to an audited snapshot plus raw-event reconstruction.

Do not silently drop lock-score penalties, change the frozen Earn volume
formula, or refresh the blocked-wallet hashes without reviewed provenance.

## Membership consistency contract

The reconciler fixes a confirmed Base RPC block before querying membership.
The indexer must satisfy all of the following:

- `chain_metadata.latest_processed_block` is at least the fixed block.
- Every configured group has an `AddressGroup` row produced by its
  `GroupCreated` event.
- `AddressGroupMembershipEvent` contains every add/remove event from the
  registry deployment block through the fixed block.
- Every event includes first-class `chainId`, `registryAddress`, `groupId`,
  `member`, `present`, `blockNumber`, and `logIndex`.
- The configured registry source started no later than its deployment block.

RPC remains the source for bytecode, pinned `getGroup` governance reads,
simulation, writes, and receipts. It is no longer used to scan event logs.

Run `pnpm check:upstream` after fetching the sibling repositories. Runtime
surface or membership-prerequisite incompatibility exits nonzero; known tier
forward drift is reported separately.
