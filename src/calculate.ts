import type { RuntimeSettings } from "./config.js";
import { assertCascadingSets, type DesiredSnapshot, type PinnedMember, TIERS } from "./domain.js";
import { IndexerClient } from "./indexer.js";
import { calculateCurrentEarnPolicy, calculateHistoricalTakerPolicy } from "./policies.js";
import { BLOCKED_WALLET_HASHES, isBlockedWallet } from "./staticWalletRules.js";

export function applyPinnedMembers(
  desired: DesiredSnapshot,
  pinnedMembers: PinnedMember[],
  isBlocked: (address: PinnedMember["address"]) => boolean,
): void {
  for (const member of pinnedMembers) {
    if (isBlocked(member.address)) {
      throw new Error("Pinned member configuration contains a blocked wallet");
    }
    const policy = desired.policies.get(member.scope);
    if (!policy) throw new Error(`Missing desired policy ${member.scope}`);
    const highestTierIndex = TIERS.indexOf(member.tier);
    for (let index = 0; index <= highestTierIndex; index += 1) {
      const tier = TIERS[index];
      if (tier) policy.membersByTier[tier].add(member.address);
    }
  }

  for (const policy of desired.policies.values()) {
    assertCascadingSets(policy.membersByTier, policy.scope);
  }
}

export async function calculateDesiredSnapshot(
  settings: RuntimeSettings,
  client?: IndexerClient,
): Promise<DesiredSnapshot> {
  const indexer =
    client ??
    new IndexerClient(
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

  const desired: DesiredSnapshot = {
    policies: new Map([
      [historical.scope, historical],
      [earn.scope, earn],
    ]),
    blockedWalletCount: BLOCKED_WALLET_HASHES.length,
    calculatedAt: new Date().toISOString(),
  };
  applyPinnedMembers(desired, settings.pinnedMembers, isBlockedWallet);
  return desired;
}
