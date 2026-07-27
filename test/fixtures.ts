import type { Address } from "viem";
import {
  type DesiredSnapshot,
  emptyTierSets,
  type GroupsConfig,
  normalizeAddress,
  normalizeGroupId,
  POLICY_SCOPES,
  TIERS,
} from "../src/domain.js";
import type { GroupMutation, RegistryState } from "../src/onchain.js";

export const addr = (digit: string): Address => normalizeAddress(`0x${digit.repeat(40)}`);
export const groupId = (value: number) =>
  normalizeGroupId(`0x${value.toString(16).padStart(64, "0")}`);

/**
 * Eight empty groups in TIERS order per scope, so groupId(1..4) is
 * historical-taker PEASANT/PEER/PLUS/PRO and groupId(5..8) is current-earn.
 */
export function chainFixture(): { config: GroupsConfig; onchain: RegistryState } {
  const groups = POLICY_SCOPES.flatMap((scope, scopeIndex) =>
    TIERS.map((tier, tierIndex) => ({
      scope,
      tier,
      groupId: groupId(scopeIndex * TIERS.length + tierIndex + 1),
      minimumMembers: 0,
      maximumMembers: 1_000_000,
    })),
  );
  return {
    config: {
      chainId: 8453,
      registryAddress: addr("f"),
      registryDeploymentBlock: 1n,
      groups,
    },
    onchain: {
      membersByGroupId: new Map(groups.map((group) => [group.groupId, new Set<Address>()])),
      governanceByGroupId: new Map(),
      snapshotBlock: 100n,
      indexedThroughBlock: 100n,
    },
  };
}

export function planFixture(): {
  desired: DesiredSnapshot;
  config: GroupsConfig;
  onchain: RegistryState;
} {
  const policies = new Map();
  for (const scope of POLICY_SCOPES) {
    policies.set(scope, { scope, membersByTier: emptyTierSets(), sourceRows: 1 });
  }
  return {
    desired: { policies, blockedWalletCount: 0, calculatedAt: "2026-07-27T00:00:00.000Z" },
    ...chainFixture(),
  };
}

/** Applies mutations to the fixture's chain state so multi-run convergence can be simulated. */
export function applyMutations(onchain: RegistryState, mutations: GroupMutation[]): void {
  for (const mutation of mutations) {
    const members = onchain.membersByGroupId.get(mutation.groupId);
    if (!members) throw new Error(`Unknown group ${mutation.groupId}`);
    for (const member of mutation.members) {
      if (mutation.operation === "add") members.add(member);
      else members.delete(member);
    }
  }
}
