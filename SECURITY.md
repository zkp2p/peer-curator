# Security

- Keep `INDEXER_API_KEY`, `RPC_URL`, and `GROUP_ADMIN_PRIVATE_KEY` in the
  hosting secret manager.
- Use a dedicated, minimally funded signer that owns only the configured
  groups. Prefer a policy-controlled signing service before production.
- Never commit `config/groups.json`, `.env`, calculated address sets, raw
  blocklist exports, or un-hashed wallet identifiers.
- A denylist update is security-sensitive. Review its source, count, hash
  format, local comparison, and effective tier changes.
- Run one cron replica. Concurrent signers can race nonces even though registry
  writes are idempotent.
- Treat an unexpected removal plan, schema error, resolver change, or ownership
  change as an incident. The process intentionally exits before transacting.
- Treat a stale membership watermark, missing group-creation projection,
  registry source-address drift, or incomplete event backfill as an incident.
  There is intentionally no RPC log fallback.
- Keep `SNAPSHOT_CONFIRMATIONS` nonzero in production. Lowering the confirmation
  buffer increases the chance of reconciling indexer and RPC state from
  different sides of a tip reorganization.
