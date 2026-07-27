import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { type GroupsConfig, normalizeAddress, normalizeGroupId } from "../src/domain.js";
import {
  assertRegistryGovernance,
  executeMutations,
  type GroupGovernance,
  loadRegistryState,
  type RegistryState,
} from "../src/onchain.js";
import { addr, groupId } from "./fixtures.js";

const member = (digit: string): Address => normalizeAddress(`0x${digit.repeat(40)}`);
const configuredGroupId = normalizeGroupId(`0x${"11".repeat(32)}`);

describe("loadRegistryState", () => {
  it("loads governance at the pinned block without scanning RPC logs", async () => {
    const registryAddress = member("9");
    const curator = member("8");
    const client = {
      getBytecode: vi.fn().mockResolvedValue("0x1234"),
      readContract: vi
        .fn()
        .mockResolvedValue([curator, member("0"), member("0"), false, true] as const),
      getLogs: vi.fn().mockRejectedValue(new Error("RPC logs must not be read")),
    };
    const config: GroupsConfig = {
      chainId: 8453,
      registryAddress,
      registryDeploymentBlock: 100n,
      groups: [
        {
          scope: "historical-taker",
          tier: "PEER",
          groupId: configuredGroupId,
          minimumMembers: 0,
          maximumMembers: 1_000_000,
        },
      ],
    };

    const state = await loadRegistryState(client as never, config, {
      snapshotBlock: 120n,
      indexedThroughBlock: 120n,
      membersByGroupId: new Map([[configuredGroupId, new Set([member("a")])]]),
    });

    expect(state.membersByGroupId.get(configuredGroupId)).toEqual(new Set([member("a")]));
    expect(client.getLogs).not.toHaveBeenCalled();
    expect(client.getBytecode).toHaveBeenCalledWith({
      address: registryAddress,
      blockNumber: 120n,
    });
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "getGroup", blockNumber: 120n }),
    );
  });
});

describe("assertRegistryGovernance", () => {
  const registryAddress = member("9");
  const curator = member("8");
  const config: GroupsConfig = {
    chainId: 8453,
    registryAddress,
    registryDeploymentBlock: 100n,
    groups: [
      {
        scope: "historical-taker",
        tier: "PEER",
        groupId: configuredGroupId,
        minimumMembers: 0,
        maximumMembers: 1_000_000,
      },
    ],
  };
  const state = (overrides: Partial<GroupGovernance> = {}): RegistryState => ({
    membersByGroupId: new Map([[configuredGroupId, new Set()]]),
    governanceByGroupId: new Map([
      [
        configuredGroupId,
        {
          groupId: configuredGroupId,
          curator,
          pendingCurator: member("0"),
          resolver: member("0"),
          isPublic: false,
          exists: true,
          ...overrides,
        },
      ],
    ]),
    snapshotBlock: 120n,
    indexedThroughBlock: 120n,
  });

  it("accepts a private, stable, curator-owned group", () => {
    expect(() =>
      assertRegistryGovernance({
        config,
        state: state(),
        requireZeroResolver: true,
        signer: { address: curator } as never,
      }),
    ).not.toThrow();
  });

  it("rejects self-service membership and pending curator transfers", () => {
    expect(() =>
      assertRegistryGovernance({
        config,
        state: state({ isPublic: true }),
        requireZeroResolver: true,
      }),
    ).toThrow("permits self-service membership");
    expect(() =>
      assertRegistryGovernance({
        config,
        state: state({ pendingCurator: member("7") }),
        requireZeroResolver: true,
      }),
    ).toThrow("pending curator transfer");
  });
});

describe("executeMutations transaction reporting", () => {
  function stubClients(revertAt: number) {
    let index = 0;
    const publicClient = {
      simulateContract: async () => ({}),
      waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({
        status: hash === `0x${revertAt}` ? "reverted" : "success",
      }),
    };
    const walletClient = {
      writeContract: async () => {
        const hash = `0x${index}`;
        index += 1;
        return hash;
      },
    };
    return { publicClient, walletClient };
  }

  const mutations = [
    { operation: "add" as const, groupId: groupId(1), members: [addr("1")] },
    { operation: "add" as const, groupId: groupId(2), members: [addr("1")] },
    { operation: "remove" as const, groupId: groupId(3), members: [addr("2")] },
  ];

  it("reports every confirmed hash before a later revert", async () => {
    const seen: string[] = [];
    const { publicClient, walletClient } = stubClients(2);

    await expect(
      executeMutations({
        publicClient: publicClient as never,
        walletClient: walletClient as never,
        account: {} as never,
        registryAddress: addr("f"),
        mutations,
        onTransaction: (hash) => seen.push(hash),
      }),
    ).rejects.toThrow("reverted");

    expect(seen).toEqual(["0x0", "0x1"]);
  });

  it("stops at the failing boundary wherever it falls", async () => {
    for (const revertAt of [0, 1, 2]) {
      const seen: string[] = [];
      const { publicClient, walletClient } = stubClients(revertAt);

      await expect(
        executeMutations({
          publicClient: publicClient as never,
          walletClient: walletClient as never,
          account: {} as never,
          registryAddress: addr("f"),
          mutations,
          onTransaction: (hash) => seen.push(hash),
        }),
      ).rejects.toThrow("reverted");

      expect(seen).toHaveLength(revertAt);
    }
  });

  it("prevents every removal when an add fails", async () => {
    const attempted: string[] = [];
    let index = 0;
    const publicClient = {
      simulateContract: async () => ({}),
      waitForTransactionReceipt: async () => ({ status: "reverted" }),
    };
    const walletClient = {
      writeContract: async ({ functionName }: { functionName: string }) => {
        attempted.push(functionName);
        const hash = `0x${index}`;
        index += 1;
        return hash;
      },
    };

    await expect(
      executeMutations({
        publicClient: publicClient as never,
        walletClient: walletClient as never,
        account: {} as never,
        registryAddress: addr("f"),
        mutations,
      }),
    ).rejects.toThrow("reverted");

    expect(attempted).toEqual(["addMembers"]);
  });
});
