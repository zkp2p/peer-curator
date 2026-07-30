import { type Address, encodeAbiParameters, encodeEventTopics } from "viem";
import { describe, expect, it, vi } from "vitest";
import { addressGroupRegistryAbi } from "../src/contracts.js";
import { type GroupsConfig, normalizeAddress, normalizeGroupId } from "../src/domain.js";
import {
  assertMembershipEventsMatchExpected,
  assertRegistryGovernance,
  createCuratedGroup,
  executeMutations,
  type GroupGovernance,
  loadRegistryGovernance,
  loadRegistryState,
  type RegistryState,
} from "../src/onchain.js";
import { addr, groupId } from "./fixtures.js";

const member = (digit: string): Address => normalizeAddress(`0x${digit.repeat(40)}`);
const configuredGroupId = normalizeGroupId(`0x${"11".repeat(32)}`);

describe("assertMembershipEventsMatchExpected", () => {
  it("accepts only the seed additions confirmed after the approved snapshot", async () => {
    const expectedMember = member("a");
    const publicClient = {
      getBlockNumber: vi.fn().mockResolvedValue(125n),
      getLogs: vi
        .fn()
        .mockResolvedValueOnce([{ args: { member: expectedMember } }])
        .mockResolvedValueOnce([]),
    };

    await expect(
      assertMembershipEventsMatchExpected({
        publicClient: publicClient as never,
        registryAddress: member("9"),
        groupId: configuredGroupId,
        snapshotBlock: 120n,
        expectedAddedMembers: new Set([expectedMember]),
      }),
    ).resolves.toBe(125n);
    expect(publicClient.getLogs).toHaveBeenCalledTimes(2);
  });

  it("rejects an unexpected addition or any removal after the snapshot", async () => {
    const unexpectedAdditionClient = {
      getBlockNumber: vi.fn().mockResolvedValue(125n),
      getLogs: vi
        .fn()
        .mockResolvedValueOnce([{ args: { member: member("b") } }])
        .mockResolvedValueOnce([]),
    };
    await expect(
      assertMembershipEventsMatchExpected({
        publicClient: unexpectedAdditionClient as never,
        registryAddress: member("9"),
        groupId: configuredGroupId,
        snapshotBlock: 120n,
        expectedAddedMembers: new Set(),
      }),
    ).rejects.toThrow("membership changed");

    const removalClient = {
      getBlockNumber: vi.fn().mockResolvedValue(125n),
      getLogs: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ args: { member: member("a") } }]),
    };
    await expect(
      assertMembershipEventsMatchExpected({
        publicClient: removalClient as never,
        registryAddress: member("9"),
        groupId: configuredGroupId,
        snapshotBlock: 120n,
        expectedAddedMembers: new Set(),
      }),
    ).rejects.toThrow("membership was removed");
  });
});

describe("createCuratedGroup", () => {
  it("returns the confirmed GroupCreated identity", async () => {
    const registryAddress = member("9");
    const curator = member("8");
    const name = "Peer Makers";
    const groupId = configuredGroupId;
    const topics = encodeEventTopics({
      abi: addressGroupRegistryAbi,
      eventName: "GroupCreated",
      args: { groupId, curator },
    });
    const publicClient = {
      simulateContract: vi.fn().mockResolvedValue({ request: { functionName: "createGroup" } }),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: "success",
        blockNumber: 123n,
        logs: [
          {
            address: registryAddress,
            topics,
            data: encodeAbiParameters([{ type: "string" }], [name]),
          },
        ],
      }),
    };
    const walletClient = {
      writeContract: vi.fn().mockResolvedValue(`0x${"aa".repeat(32)}`),
    };

    await expect(
      createCuratedGroup({
        publicClient: publicClient as never,
        walletClient: walletClient as never,
        account: { address: curator } as never,
        registryAddress,
        name,
      }),
    ).resolves.toEqual({
      groupId,
      transactionHash: `0x${"aa".repeat(32)}`,
      blockNumber: 123n,
    });
  });
});

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

describe("loadRegistryGovernance", () => {
  it("can read current governance without reusing the plan block", async () => {
    const registryAddress = member("9");
    const client = {
      readContract: vi
        .fn()
        .mockResolvedValue([member("8"), member("0"), member("0"), false, true] as const),
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

    await loadRegistryGovernance(client as never, config);

    expect(client.readContract).toHaveBeenCalledWith(
      expect.not.objectContaining({ blockNumber: expect.anything() }),
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
      getTransactionCount: async () => 7,
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

  it("runs the mutation preflight before every transaction", async () => {
    const seen: number[] = [];
    const { publicClient, walletClient } = stubClients(-1);

    await executeMutations({
      publicClient: publicClient as never,
      walletClient: walletClient as never,
      account: {} as never,
      registryAddress: addr("f"),
      mutations,
      beforeMutation: async (_mutation, transactionIndex) => {
        seen.push(transactionIndex);
      },
    });

    expect(seen).toEqual([0, 1, 2]);
  });

  it("pins the pending nonce once and increments it after each receipt", async () => {
    const nonces: number[] = [];
    let transactionCountReads = 0;
    let index = 0;
    const publicClient = {
      getTransactionCount: async () => {
        transactionCountReads += 1;
        return 41;
      },
      simulateContract: async () => ({}),
      waitForTransactionReceipt: async () => ({ status: "success" }),
    };
    const walletClient = {
      writeContract: async ({ nonce }: { nonce: number }) => {
        nonces.push(nonce);
        const hash = `0x${index}`;
        index += 1;
        return hash;
      },
    };

    await executeMutations({
      publicClient: publicClient as never,
      walletClient: walletClient as never,
      account: { address: addr("f") } as never,
      registryAddress: addr("f"),
      mutations,
    });

    expect(transactionCountReads).toBe(1);
    expect(nonces).toEqual([41, 42, 43]);
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
      getTransactionCount: async () => 7,
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
