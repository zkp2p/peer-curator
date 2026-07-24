import { Client } from "pg";
import type { Address } from "viem";
import { normalizeAddress } from "./domain.js";

interface BlockedWalletRow {
  walletAddress: string;
}

export async function getBlockedWallets(
  connectionString: string,
  timeoutMs: number,
): Promise<Set<Address>> {
  const client = new Client({
    connectionString,
    application_name: "zkp2p-taker-groups",
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
  });

  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const result = await client.query<BlockedWalletRow>(
      'SELECT "walletAddress" FROM "BlockedWallet" ORDER BY lower("walletAddress")',
    );
    await client.query("COMMIT");
    return new Set(
      result.rows.map((row) => normalizeAddress(row.walletAddress, "BlockedWallet.walletAddress")),
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
