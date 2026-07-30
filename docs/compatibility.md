# Producer compatibility

Baseline reviewed on 2026-07-30.

| Producer | Surface | Requirement |
|---|---|---|
| Contracts `origin/main` | payment-method lookups | canonical PayPal, Venmo, and Cash App name/hash mappings consumed from `@zkp2p/contracts-v2@0.3.0` |
| Contracts `origin/main` | `AddressGroupRegistry` | bytes32 group IDs; five-value `getGroup`; `addMembers` and `removeMembers` |
| Indexer qualification aggregates | `TakerPlatformStats` | `chainId`, `taker`, `paymentMethodHash`, and `totalAmountTaken` for bounded fixed pages plus an explicit overflow page |
| Indexer current membership | `AddressGroup`, `AddressGroupMember` | all three groups enumerable, with `memberCount` equal to the matching member rows |
| Indexer synchronization | `chain_metadata` | one valid processed-block watermark co-read with every reconciliation root in one GraphQL document |
| Indexer environment config | `AddressGroupRegistry` source | a nonzero registry address bound in the matching environment |
| Curator history | tier policy and blocked wallets | provenance only; there is no runtime Curator dependency |

`pnpm check:upstream` inspects the fetched sibling repositories. Any missing
runtime field, membership projection, handler mutation, bytes32 ABI surface, or
environment registry binding is incompatible and makes the command exit
nonzero. Production intentionally remains incompatible until its registry is
deployed and bound.

## Membership consistency contract

For `plan` and `sync`, the reconciler:

- requests `chain_metadata`, qualifying `TakerPlatformStats` fixed/overflow
  pages, configured `AddressGroup` rows, and `AddressGroupMember`
  fixed/overflow pages in one GraphQL document that Hasura compiles to one SQL
  statement;
- enumerates `AddressGroupMember` for exactly the configured chain, registry,
  and bytes32 group IDs and fails above the hard row caps;
- requires every `AddressGroup` row and verifies `memberCount` parity;
- requires fixed pages to be contiguous and both overflow pages to be empty;
- requires the co-read watermark to be at least `SNAPSHOT_CONFIRMATIONS` behind
  the RPC head;
- reads bytecode and `getGroup` at that exact watermark.

This accepts an indexer that is behind the RPC head; it never demands that the
indexer reach a block derived from the latest RPC tip. It also avoids using an
unconfirmed latest indexer state. Envio/Hasura does not expose a historical
block argument for these mutable domain entities, so multiple requests cannot
be treated as block-pinned. The single compiled SQL statement is the consistency
boundary.

RPC remains the source for pinned contract governance, simulation, writes, and
receipts. It is not used to enumerate members or scan logs.

Do not add another qualifying platform, accept decimal group IDs, or refresh
blocked-wallet hashes without reviewed policy and provenance.
