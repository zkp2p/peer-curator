import { type Address, type Hex, isAddress } from "viem";

export const TIERS = ["PEER", "PLUS", "PRO"] as const;
export type Tier = (typeof TIERS)[number];

export const POLICY_SCOPES = ["historical-taker", "current-earn"] as const;
export type PolicyScope = (typeof POLICY_SCOPES)[number];

export type GroupKey = `${PolicyScope}:${Tier}`;
export type GroupId = Hex;

export interface GroupDefinition {
  scope: PolicyScope;
  tier: Tier;
  groupId: GroupId;
  minimumMembers: number;
  maximumMembers: number;
}

export interface GroupsConfig {
  chainId: number;
  registryAddress: Address;
  registryDeploymentBlock: bigint;
  groups: GroupDefinition[];
}

export interface TieredMember {
  address: Address;
  tier: Tier;
}

export interface PolicySnapshot {
  scope: PolicyScope;
  membersByTier: Record<Tier, Set<Address>>;
  sourceRows: number;
}

export interface DesiredSnapshot {
  policies: Map<PolicyScope, PolicySnapshot>;
  blockedWalletCount: number;
  calculatedAt: string;
}

export function groupKey(scope: PolicyScope, tier: Tier): GroupKey {
  return `${scope}:${tier}`;
}

export function emptyTierSets(): Record<Tier, Set<Address>> {
  return {
    PEER: new Set<Address>(),
    PLUS: new Set<Address>(),
    PRO: new Set<Address>(),
  };
}

export function normalizeAddress(value: string, field = "address"): Address {
  const normalized = value.trim().toLowerCase();
  if (!isAddress(normalized, { strict: true })) {
    throw new Error(`Invalid ${field}`);
  }
  return normalized as Address;
}

export function normalizeGroupId(value: string, field = "groupId"): GroupId {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Invalid ${field}`);
  }
  return normalized as GroupId;
}

export function tierCounts(snapshot: PolicySnapshot): Record<Tier, number> {
  return {
    PEER: snapshot.membersByTier.PEER.size,
    PLUS: snapshot.membersByTier.PLUS.size,
    PRO: snapshot.membersByTier.PRO.size,
  };
}

/**
 * Tier sets cascade, so a PRO member also appears in PLUS and PEER.
 * Iterating ascending would report PEER for every curated wallet, so this
 * walks the ladder downward and returns the highest tier actually held.
 */
export function tierForAddress(snapshot: PolicySnapshot, address: Address): Tier | "PEASANT" {
  for (let index = TIERS.length - 1; index >= 0; index -= 1) {
    const tier = TIERS[index];
    if (tier && snapshot.membersByTier[tier].has(address)) return tier;
  }
  return "PEASANT";
}

/**
 * Tier membership is nested: every member of a tier must also belong to every
 * lower tier. Throws on the first violation so a malformed snapshot can never
 * reach the registry.
 */
export function assertCascadingSets(
  membersByTier: Record<Tier, Set<Address>>,
  label: string,
): void {
  for (let index = TIERS.length - 1; index > 0; index -= 1) {
    const higher = TIERS[index];
    const lower = TIERS[index - 1];
    if (!higher || !lower) continue;
    for (const address of membersByTier[higher]) {
      if (!membersByTier[lower].has(address)) {
        throw new Error(`${label} is not cascading: a ${higher} member is missing from ${lower}`);
      }
    }
  }
}
