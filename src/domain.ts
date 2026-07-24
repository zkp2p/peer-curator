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

export function tierForAddress(snapshot: PolicySnapshot, address: Address): Tier | "PEASANT" {
  for (const tier of TIERS) {
    if (snapshot.membersByTier[tier].has(address)) return tier;
  }
  return "PEASANT";
}
