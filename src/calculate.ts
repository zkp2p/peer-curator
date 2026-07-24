import { getBlockedWallets } from "./blocklist.js";
import type { RuntimeSettings } from "./config.js";
import type { DesiredSnapshot } from "./domain.js";
import { IndexerClient } from "./indexer.js";
import { calculateCurrentEarnPolicy, calculateHistoricalTakerPolicy } from "./policies.js";

export async function calculateDesiredSnapshot(
  settings: RuntimeSettings,
): Promise<DesiredSnapshot> {
  const indexer = new IndexerClient(
    settings.indexerUrl,
    settings.indexerApiKey,
    settings.groups.chainId,
    settings.requestTimeoutMs,
  );

  const [takerStats, platformStats, peerPayStats, blockedWallets] = await Promise.all([
    indexer.getTakerStats(),
    indexer.getMakerPlatformStats(),
    indexer.getMakerPeerPayStats(),
    getBlockedWallets(settings.curatorDatabaseUrl, settings.requestTimeoutMs),
  ]);

  const historical = calculateHistoricalTakerPolicy({
    takerStats,
    blockedWallets,
    platinumOverrides: settings.legacyPlatinumOverrides,
  });
  const earn = calculateCurrentEarnPolicy({
    platformStats,
    peerPayStats,
    takerStats,
    blockedWallets,
  });

  return {
    policies: new Map([
      [historical.scope, historical],
      [earn.scope, earn],
    ]),
    blockedWalletCount: blockedWallets.size,
    calculatedAt: new Date().toISOString(),
  };
}
