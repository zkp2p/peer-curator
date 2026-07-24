# Producer compatibility

Baseline captured on 2026-07-24.

| Producer | Ref/commit | Surface | Status | Evidence |
|---|---|---|---|---|
| Contracts | `origin/main` / `764a125d7a859184127a36c44de3beaf5611c0d5` | `AddressGroupRegistry` reads, writes, events | Compatible | `addMembers`, `removeMembers`, `getGroup`, `MemberAdded`, and `MemberRemoved` match the embedded minimal ABI. |
| Indexer production | `origin/releases/prod` / `6aad2038e6d45d9c3202725eafb149554a3dff25` | Legacy taker and frozen Earn aggregates | Compatible | Production exposes `TakerStats.lockScore`, `MakerPlatformStats.totalAmountTakenPreEarnCutover`, and `MakerPeerPayStats.ppTakenPostEarnCutover`. |
| Indexer main | `origin/main` / `9bc2e14586b6275dd14e4b2d4e4d6262fd582691` | Legacy taker and frozen Earn aggregates | **High-severity forward incompatibility** | Main intentionally removed all three retired policy fields/entities. The runtime query will fail closed; no transaction will be sent. |
| Curator history | pre-Earn tier implementation and 2026-07-24 production snapshot | Tier policy and blocked wallets | Provenance only | This repository owns the preserved formulas and the hashed blocked-wallet snapshot. There is no Curator runtime dependency. |

The production runtime is compatible today. Before promoting the current
indexer `main`, choose one of:

1. Retain the four aggregate fields/entities as a supported operational
   surface.
2. Add a replacement indexer query with equivalent frozen-volume and
   lock-score semantics.
3. Migrate this service to an audited snapshot plus raw-event reconstruction.

Do not silently drop lock-score penalties, change the frozen Earn volume
formula, or refresh the blocked-wallet hashes without reviewed provenance.

Run `pnpm check:upstream` after fetching the sibling repositories. Runtime
surface incompatibility exits nonzero; known forward drift is reported
separately.
