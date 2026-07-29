# Producer compatibility

Baseline reviewed on 2026-07-24.

| Producer | Surface | Requirement |
|---|---|---|
| Contracts `origin/main` (`ce038e6c`) | `AddressGroupRegistry` | bytes32 group IDs; five-value `getGroup`; `addMembers` and `removeMembers` |
| Indexer tier aggregates | `TakerStats` | lifetime fulfilled volume and lock score used by the historical-taker policy |
| Indexer current membership | `AddressGroup`, `AddressGroupMember` | all three groups enumerable, with `memberCount` equal to the matching member rows |
| Indexer synchronization | `chain_metadata` | one valid processed-block watermark for chain 8453 |
| Indexer environment config | `AddressGroupRegistry` source | a nonzero registry address bound in the matching environment |
| Curator history | tier policy and blocked wallets | provenance only; there is no runtime Curator dependency |

`pnpm check:upstream` inspects the fetched sibling repositories. Any missing
runtime field, membership projection, handler mutation, bytes32 ABI surface, or
environment registry binding is incompatible and makes the command exit
nonzero. Production intentionally remains incompatible until its registry is
deployed and bound.

## Membership consistency contract

For `plan` and `sync`, the reconciler:

- captures `chain_metadata.latest_processed_block` before reading any desired
  aggregate or membership row;
- enumerates `AddressGroupMember` for exactly the configured chain, registry,
  and bytes32 group IDs;
- requires every `AddressGroup` row and verifies `memberCount` parity;
- rereads the watermark after all indexer queries and requires an exact match;
- requires the stable watermark to be at least `SNAPSHOT_CONFIRMATIONS` behind
  the RPC head;
- reads bytecode and `getGroup` at that exact watermark.

This accepts an indexer that is behind the RPC head; it never demands that the
indexer reach a block derived from the latest RPC tip. It also avoids using an
unconfirmed latest indexer state. Envio/Hasura does not expose historical
queries for mutable domain entities, so a changing watermark fails closed and
the next scheduled run retries from a new stable state.

RPC remains the source for pinned contract governance, simulation, writes, and
receipts. It is not used to enumerate members or scan logs.

Do not silently drop lock-score penalties, accept decimal group IDs, or refresh
blocked-wallet hashes without reviewed provenance.
