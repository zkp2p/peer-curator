# Security

- Keep `INDEXER_API_KEY`, `CURATOR_DATABASE_URL`, `RPC_URL`, and
  `GROUP_ADMIN_PRIVATE_KEY` in the hosting secret manager.
- Use a dedicated, minimally funded signer that owns only the configured
  groups. Prefer a policy-controlled signing service before production.
- Never commit `config/groups.json`, `.env`, calculated address sets, or raw
  blocklist exports.
- Run one cron replica. Concurrent signers can race nonces even though registry
  writes are idempotent.
- Treat an unexpected removal plan, schema error, resolver change, or ownership
  change as an incident. The process intentionally exits before transacting.
