import type { RuntimeSettings } from "./config.js";
import type { DesiredSnapshot } from "./domain.js";
import { IndexerClient } from "./indexer.js";
import { calculateCurrentEarnPolicy, calculateHistoricalTakerPolicy } from "./policies.js";
import { BLOCKED_WALLET_HASHES, isBlockedWallet } from "./staticWalletRules.js";

export async function calculateDesiredSnapshot(
  settings: RuntimeSettings,
): Promise<DesiredSnapshot> {
  const indexer = new IndexerClient(
    settings.indexerUrl,
    settings.indexerApiKey,
    settings.chainId,
    settings.requestTimeoutMs,
  );

  const [takerStats, platformStats, peerPayStats] = await Promise.all([
    indexer.getTakerStats(),
    indexer.getMakerPlatformStats(),
    indexer.getMakerPeerPayStats(),
  ]);

  const historical = calculateHistoricalTakerPolicy({
    takerStats,
    isBlockedWallet,
  });
  const earn = calculateCurrentEarnPolicy({
    platformStats,
    peerPayStats,
    takerStats,
    isBlockedWallet,
  });

  return {
    policies: new Map([
      [historical.scope, historical],
      [earn.scope, earn],
    ]),
    blockedWalletCount: BLOCKED_WALLET_HASHES.length,
    calculatedAt: new Date().toISOString(),
  };
}
