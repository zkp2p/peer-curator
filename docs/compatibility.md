# Producer compatibility

Baseline captured on 2026-07-24.

| Producer | Ref/commit | Surface | Status | Evidence |
|---|---|---|---|---|
| Contracts | `origin/main` / `764a125d7a859184127a36c44de3beaf5611c0d5` | `AddressGroupRegistry` reads, writes, events | Compatible | `addMembers`, `removeMembers`, `getGroup`, `MemberAdded`, and `MemberRemoved` match the embedded minimal ABI. |
| Indexer production | `origin/releases/prod` / `6aad2038e6d45d9c3202725eafb149554a3dff25` | Legacy taker and frozen Earn aggregates | Compatible | Production exposes `TakerStats.lockScore`, `MakerPlatformStats.totalAmountTakenPreEarnCutover`, and `MakerPeerPayStats.ppTakenPostEarnCutover`. |
| Indexer main | `origin/main` / `9bc2e14586b6275dd14e4b2d4e4d6262fd582691` | Legacy taker and frozen Earn aggregates | **High-severity forward incompatibility** | Main intentionally removed all three retired policy fields/entities. The runtime query will fail closed; no transaction will be sent. |
| Curator production | `origin/releases/prod` / `eb5deb30deb8a76b6e4c19fb79bbc66bb6ee5031` | `BlockedWallet` | Compatible | The table remains DB-backed and is read inside a read-only transaction. |
| Curator main | `origin/main` / `047205185633d7c9348e3cdfcca152e233efdcda` | Tier policy | Expected ownership move | Retired tier tables/policy are gone; this repository owns the preserved policy definitions. `BlockedWallet` remains. |

The production runtime is compatible today. Before promoting the current
indexer `main`, choose one of:

1. Retain the four aggregate fields/entities as a supported operational
   surface.
2. Add a replacement indexer query with equivalent frozen-volume and
   lock-score semantics.
3. Migrate this service to an audited snapshot plus raw-event reconstruction.

Do not silently drop lock-score penalties or change the frozen Earn volume
formula.

Run `pnpm check:upstream` after fetching the sibling repositories. Runtime
surface incompatibility exits nonzero; known forward drift is reported
separately.
