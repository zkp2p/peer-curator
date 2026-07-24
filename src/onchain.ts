import type {
  Account,
  Address,
  PrivateKeyAccount,
  PublicClient,
  Transport,
  WalletClient,
} from "viem";
import { zeroAddress } from "viem";
import { base } from "viem/chains";
import { addressGroupRegistryAbi } from "./contracts.js";
import { type GroupsConfig, normalizeAddress } from "./domain.js";
import type { IndexedMembershipSnapshot } from "./indexer.js";

export interface MembershipEvent {
  groupId: bigint;
  member: Address;
  present: boolean;
  blockNumber: bigint;
  logIndex: bigint;
}

export interface GroupGovernance {
  groupId: bigint;
  owner: Address;
  pendingOwner: Address;
  resolver: Address;
  exists: boolean;
}

export interface RegistryState {
  membersByGroupId: Map<bigint, Set<Address>>;
  governanceByGroupId: Map<bigint, GroupGovernance>;
  snapshotBlock: bigint;
  indexedThroughBlock: bigint;
}

export interface GroupMutation {
  operation: "add" | "remove";
  groupId: bigint;
  members: Address[];
}

export function replayMembershipEvents(
  events: MembershipEvent[],
  groupIds: Iterable<bigint>,
): Map<bigint, Set<Address>> {
  const state = new Map<bigint, Set<Address>>();
  for (const groupId of groupIds) state.set(groupId, new Set<Address>());

  const ordered = [...events].sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber < right.blockNumber ? -1 : 1;
    }
    if (left.logIndex === right.logIndex) return 0;
    return left.logIndex < right.logIndex ? -1 : 1;
  });

  for (const event of ordered) {
    const members = state.get(event.groupId);
    if (!members) {
      throw new Error("Membership history contains an unexpected group");
    }
    if (event.present) members.add(event.member);
    else members.delete(event.member);
  }
  return state;
}

export async function loadRegistryState<transport extends Transport>(
  client: PublicClient<transport, typeof base>,
  config: GroupsConfig,
  membership: IndexedMembershipSnapshot,
): Promise<RegistryState> {
  if (membership.indexedThroughBlock < membership.snapshotBlock) {
    throw new Error("Indexer membership snapshot is incomplete");
  }
  if (config.registryDeploymentBlock > membership.snapshotBlock) {
    throw new Error("registryDeploymentBlock is greater than the chain snapshot");
  }
  const bytecode = await client.getBytecode({
    address: config.registryAddress,
    blockNumber: membership.snapshotBlock,
  });
  if (!bytecode || bytecode === "0x") {
    throw new Error("AddressGroupRegistry has no deployed bytecode");
  }

  const uniqueGroupIds = [...new Set(config.groups.map((group) => group.groupId))];
  const governanceRows = await Promise.all(
    uniqueGroupIds.map(async (groupId): Promise<GroupGovernance> => {
      const [owner, pendingOwner, resolver, exists] = await client.readContract({
        address: config.registryAddress,
        abi: addressGroupRegistryAbi,
        functionName: "getGroup",
        args: [groupId],
        blockNumber: membership.snapshotBlock,
      });
      return {
        groupId,
        owner: normalizeAddress(owner),
        pendingOwner: normalizeAddress(pendingOwner),
        resolver: normalizeAddress(resolver),
        exists,
      };
    }),
  );

  return {
    membersByGroupId: replayMembershipEvents(membership.events, uniqueGroupIds),
    governanceByGroupId: new Map(governanceRows.map((row) => [row.groupId, row])),
    snapshotBlock: membership.snapshotBlock,
    indexedThroughBlock: membership.indexedThroughBlock,
  };
}

export function assertRegistryGovernance(input: {
  config: GroupsConfig;
  state: RegistryState;
  requireZeroResolver: boolean;
  signer?: Account;
}): void {
  for (const group of input.config.groups) {
    const governance = input.state.governanceByGroupId.get(group.groupId);
    if (!governance?.exists) {
      throw new Error(`Configured group ${group.groupId} does not exist`);
    }
    if (input.requireZeroResolver && governance.resolver !== zeroAddress) {
      throw new Error(`Configured group ${group.groupId} has a nonzero resolver`);
    }
    if (input.signer && governance.owner.toLowerCase() !== input.signer.address.toLowerCase()) {
      throw new Error(`Signer is not the owner of configured group ${group.groupId}`);
    }
  }
}

export async function executeMutations<
  publicTransport extends Transport,
  walletTransport extends Transport,
>(input: {
  publicClient: PublicClient<publicTransport, typeof base>;
  walletClient: WalletClient<walletTransport, typeof base, PrivateKeyAccount>;
  account: PrivateKeyAccount;
  registryAddress: Address;
  mutations: GroupMutation[];
}): Promise<`0x${string}`[]> {
  const transactionHashes: `0x${string}`[] = [];
  for (const mutation of input.mutations) {
    let hash: `0x${string}`;
    if (mutation.operation === "add") {
      await input.publicClient.simulateContract({
        account: input.account,
        address: input.registryAddress,
        abi: addressGroupRegistryAbi,
        functionName: "addMembers",
        args: [mutation.groupId, mutation.members],
      });
      hash = await input.walletClient.writeContract({
        account: input.account,
        chain: base,
        address: input.registryAddress,
        abi: addressGroupRegistryAbi,
        functionName: "addMembers",
        args: [mutation.groupId, mutation.members],
      });
    } else {
      await input.publicClient.simulateContract({
        account: input.account,
        address: input.registryAddress,
        abi: addressGroupRegistryAbi,
        functionName: "removeMembers",
        args: [mutation.groupId, mutation.members],
      });
      hash = await input.walletClient.writeContract({
        account: input.account,
        chain: base,
        address: input.registryAddress,
        abi: addressGroupRegistryAbi,
        functionName: "removeMembers",
        args: [mutation.groupId, mutation.members],
      });
    }
    const receipt = await input.publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });
    if (receipt.status !== "success") {
      throw new Error(`Registry transaction reverted: ${hash}`);
    }
    transactionHashes.push(hash);
  }
  return transactionHashes;
}
