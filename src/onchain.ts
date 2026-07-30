import type {
  Account,
  Address,
  PrivateKeyAccount,
  PublicClient,
  Transport,
  WalletClient,
} from "viem";
import { parseEventLogs, zeroAddress } from "viem";
import { base } from "viem/chains";
import { addressGroupRegistryAbi } from "./contracts.js";
import { type GroupId, type GroupsConfig, normalizeAddress, normalizeGroupId } from "./domain.js";
import type { IndexedMembershipSnapshot } from "./indexer.js";

export interface GroupGovernance {
  groupId: GroupId;
  curator: Address;
  pendingCurator: Address;
  resolver: Address;
  isPublic: boolean;
  exists: boolean;
}

export interface RegistryState {
  membersByGroupId: Map<GroupId, Set<Address>>;
  governanceByGroupId: Map<GroupId, GroupGovernance>;
  snapshotBlock: bigint;
  indexedThroughBlock: bigint;
}

export interface GroupMutation {
  operation: "add" | "remove";
  groupId: GroupId;
  members: Address[];
}

export async function createCuratedGroup<
  publicTransport extends Transport,
  walletTransport extends Transport,
>(input: {
  publicClient: PublicClient<publicTransport, typeof base>;
  walletClient: WalletClient<walletTransport, typeof base, PrivateKeyAccount>;
  account: PrivateKeyAccount;
  registryAddress: Address;
  name: string;
}): Promise<{ groupId: GroupId; transactionHash: `0x${string}`; blockNumber: bigint }> {
  const simulation = await input.publicClient.simulateContract({
    account: input.account,
    address: input.registryAddress,
    abi: addressGroupRegistryAbi,
    functionName: "createGroup",
    args: [input.name],
  });
  const transactionHash = await input.walletClient.writeContract(simulation.request);
  const receipt = await input.publicClient.waitForTransactionReceipt({
    hash: transactionHash,
    confirmations: 1,
  });
  if (receipt.status !== "success") {
    throw new Error(`Registry group creation reverted: ${transactionHash}`);
  }
  const created = parseEventLogs({
    abi: addressGroupRegistryAbi,
    eventName: "GroupCreated",
    logs: receipt.logs,
    strict: true,
  }).filter(
    (log) =>
      log.address.toLowerCase() === input.registryAddress.toLowerCase() &&
      log.args.curator.toLowerCase() === input.account.address.toLowerCase() &&
      log.args.name === input.name,
  );
  if (created.length !== 1 || !created[0]) {
    throw new Error("Group creation receipt did not contain one matching GroupCreated event");
  }
  return {
    groupId: normalizeGroupId(created[0].args.groupId),
    transactionHash,
    blockNumber: receipt.blockNumber,
  };
}

export async function loadRegistryGovernance<transport extends Transport>(
  client: PublicClient<transport, typeof base>,
  config: GroupsConfig,
  blockNumber?: bigint,
): Promise<Map<GroupId, GroupGovernance>> {
  const uniqueGroupIds = [...new Set(config.groups.map((group) => group.groupId))];
  const governanceRows = await Promise.all(
    uniqueGroupIds.map(async (groupId): Promise<GroupGovernance> => {
      const [curator, pendingCurator, resolver, isPublic, exists] = await client.readContract({
        address: config.registryAddress,
        abi: addressGroupRegistryAbi,
        functionName: "getGroup",
        args: [groupId],
        ...(blockNumber !== undefined ? { blockNumber } : {}),
      });
      return {
        groupId,
        curator: normalizeAddress(curator),
        pendingCurator: normalizeAddress(pendingCurator),
        resolver: normalizeAddress(resolver),
        isPublic,
        exists,
      };
    }),
  );
  return new Map(governanceRows.map((row) => [row.groupId, row]));
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

  const governanceByGroupId = await loadRegistryGovernance(
    client,
    config,
    membership.snapshotBlock,
  );

  return {
    membersByGroupId: membership.membersByGroupId,
    governanceByGroupId,
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
    if (governance.isPublic) {
      throw new Error(`Configured group ${group.groupId} permits self-service membership`);
    }
    if (governance.pendingCurator !== zeroAddress) {
      throw new Error(`Configured group ${group.groupId} has a pending curator transfer`);
    }
    if (input.requireZeroResolver && governance.resolver !== zeroAddress) {
      throw new Error(`Configured group ${group.groupId} has a nonzero resolver`);
    }
    if (input.signer && governance.curator.toLowerCase() !== input.signer.address.toLowerCase()) {
      throw new Error(`Signer is not the curator of configured group ${group.groupId}`);
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
  onTransaction?: (hash: `0x${string}`, mutation: GroupMutation) => void;
}): Promise<`0x${string}`[]> {
  const transactionHashes: `0x${string}`[] = [];
  if (input.mutations.length === 0) return transactionHashes;
  let nextNonce = await input.publicClient.getTransactionCount({
    address: input.account.address,
    blockTag: "pending",
  });
  for (const mutation of input.mutations) {
    let hash: `0x${string}`;
    if (mutation.operation === "add") {
      await input.publicClient.simulateContract({
        account: input.account,
        address: input.registryAddress,
        abi: addressGroupRegistryAbi,
        functionName: "addMembers",
        args: [mutation.groupId, mutation.members],
        nonce: nextNonce,
      });
      hash = await input.walletClient.writeContract({
        account: input.account,
        chain: base,
        address: input.registryAddress,
        abi: addressGroupRegistryAbi,
        functionName: "addMembers",
        args: [mutation.groupId, mutation.members],
        nonce: nextNonce,
      });
    } else {
      await input.publicClient.simulateContract({
        account: input.account,
        address: input.registryAddress,
        abi: addressGroupRegistryAbi,
        functionName: "removeMembers",
        args: [mutation.groupId, mutation.members],
        nonce: nextNonce,
      });
      hash = await input.walletClient.writeContract({
        account: input.account,
        chain: base,
        address: input.registryAddress,
        abi: addressGroupRegistryAbi,
        functionName: "removeMembers",
        args: [mutation.groupId, mutation.members],
        nonce: nextNonce,
      });
    }
    const receipt = await input.publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });
    if (receipt.status !== "success") {
      throw new Error(`Registry transaction reverted: ${hash}`);
    }
    nextNonce += 1;
    transactionHashes.push(hash);
    input.onTransaction?.(hash, mutation);
  }
  return transactionHashes;
}
