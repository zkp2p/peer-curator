# Producer compatibility

Baseline reviewed on 2026-07-30.

| Producer | Surface | Requirement |
|---|---|---|
| Contracts `origin/main` | payment-method lookups | canonical PayPal, Venmo, and Cash App name/hash mappings consumed from `@zkp2p/contracts-v2@0.3.0` |
| Contracts `origin/main` | `AddressGroupRegistry` | bytes32 group IDs; five-value `getGroup`; `addMembers` and `removeMembers` |
| Indexer qualification events | `Escrow_V2_IntentSignaled/Fulfilled`, `Orchestrator_V21_IntentSignaled/Fulfilled` | immutable event IDs encode chain/block/log; signal rows provide taker/platform and fulfillment rows provide filled amount |
| Indexer legacy mapping | `src/utils/paymentMethods.ts` | reviewed environment-specific V2 verifier-to-method mapping selected by `V2_HISTORY_ENVIRONMENT`; canonical method hashes remain consumed from contracts |
| Indexer membership events | `AddressGroupRegistry_GroupCreated/MemberAdded/MemberRemoved` | immutable event IDs encode chain/block/log and allow deterministic membership replay |
| Indexer current projections | `TakerPlatformStats`, `AddressGroup`, `AddressGroupMember` | calculation parity and post-run member-count/enumeration verification |
| Indexer synchronization | `chain_metadata` | one valid processed-block watermark from which an explicit confirmed block can be selected |
| Indexer environment config | `AddressGroupRegistry` source | a nonzero registry address bound in the matching environment |
| Curator history | tier policy and blocked wallets | provenance only; there is no runtime Curator dependency |

`pnpm check:upstream` inspects the fetched sibling repositories. Any missing
runtime field, membership projection, handler mutation, bytes32 ABI surface, or
environment registry binding is incompatible and makes the command exit
nonzero. Production intentionally remains incompatible until its registry is
deployed and bound.

## Membership consistency contract

For `plan` and `sync`, the reconciler:

- chooses `min(indexer watermark, RPC head - SNAPSHOT_CONFIRMATIONS)`;
- bounds every immutable event query to that exact block through the encoded
  event ID and revalidates every returned chain/block/log tuple locally;
- reconstructs chargebackable taker totals from the V2 and unified lifecycle
  streams and group membership from creation/add/remove streams;
- fails on duplicate or malformed events, missing correlations, impossible
  membership transitions, non-advancing pagination, or hard row caps;
- reads bytecode and `getGroup` at that exact block.

This accepts an indexer behind the RPC head and remains consistent while its
watermark advances because rows at or below the chosen finalized block are
immutable. Envio/Hasura does not expose historical block arguments for mutable
domain entities, so those entities are intentionally excluded from plan/sync
state construction. They remain the post-run verification surface after the
watermark covers the last receipt.

RPC remains the source for pinned contract governance, simulation, writes, and
receipts. It is not used to enumerate members or scan logs.

Do not add another qualifying platform, accept decimal group IDs, or refresh
blocked-wallet hashes without reviewed policy and provenance.
