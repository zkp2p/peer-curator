import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeAddress, normalizeGroupId } from "../src/domain.js";
import { IndexerClient } from "../src/indexer.js";

const takerStatsResponse = {
  data: {
    TakerStats: [
      {
        id: "8453_0x1111111111111111111111111111111111111111",
        owner: "0x1111111111111111111111111111111111111111",
        totalFulfilledVolume: "500000000",
        lockScore: "0",
      },
    ],
  },
};

function mockIndexer(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(takerStatsResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IndexerClient authentication", () => {
  it("omits x-api-key for public rate-limited access", async () => {
    const fetchMock = mockIndexer();
    const client = new IndexerClient("https://indexer.example/graphql", undefined, 8453, 1_000);

    await client.getTakerStats();

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("sends x-api-key when configured", async () => {
    const fetchMock = mockIndexer();
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    await client.getTakerStats();

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-api-key");
  });
});

describe("IndexerClient address-group membership", () => {
  const registryAddress = normalizeAddress("0x9999999999999999999999999999999999999999");
  const firstMember = "0x1111111111111111111111111111111111111111";
  const secondMember = "0x2222222222222222222222222222222222222222";
  const firstGroupId = normalizeGroupId(`0x${"11".repeat(32)}`);
  const secondGroupId = normalizeGroupId(`0x${"22".repeat(32)}`);

  function mockMembershipIndexer(options?: {
    indexedThroughBlock?: number;
    groups?: unknown[];
    members?: unknown[];
  }): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      let data: Record<string, unknown>;
      if (body.query.includes("IndexerSyncWatermark")) {
        data = {
          chain_metadata: [
            {
              chain_id: 8453,
              latest_processed_block: options?.indexedThroughBlock ?? 120,
            },
          ],
        };
      } else if (body.query.includes("ConfiguredAddressGroups")) {
        data = {
          AddressGroup:
            options?.groups ??
            [firstGroupId, secondGroupId].map((groupId) => ({
              id: `8453_${registryAddress}_${groupId}`,
              chainId: 8453,
              registryAddress: registryAddress.toUpperCase(),
              groupId,
              memberCount: 1,
            })),
        };
      } else if (body.query.includes("ConfiguredAddressGroupMembers")) {
        data = {
          AddressGroupMember: options?.members ?? [
            {
              id: `8453_${registryAddress}_${firstGroupId}_${firstMember}`,
              chainId: 8453,
              registryAddress,
              groupId: firstGroupId,
              groupEntityId: `8453_${registryAddress}_${firstGroupId}`,
              member: firstMember,
            },
            {
              id: `8453_${registryAddress}_${secondGroupId}_${secondMember}`,
              chainId: 8453,
              registryAddress,
              groupId: secondGroupId,
              groupEntityId: `8453_${registryAddress}_${secondGroupId}`,
              member: secondMember,
            },
          ],
        };
      } else {
        throw new Error("Unexpected GraphQL operation");
      }
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("reads the current indexed membership projection at a pinned watermark", async () => {
    const fetchMock = mockMembershipIndexer();
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    expect(await client.getIndexedThroughBlock()).toBe(120n);
    const snapshot = await client.getAddressGroupMembershipSnapshot({
      registryAddress,
      groupIds: [firstGroupId, secondGroupId],
      deploymentBlock: 100n,
      snapshotBlock: 120n,
    });

    expect(snapshot.indexedThroughBlock).toBe(120n);
    expect(snapshot.snapshotBlock).toBe(120n);
    expect(snapshot.membersByGroupId.get(firstGroupId)).toEqual(
      new Set([normalizeAddress(firstMember)]),
    );
    expect(snapshot.membersByGroupId.get(secondGroupId)).toEqual(
      new Set([normalizeAddress(secondMember)]),
    );

    const memberRequest = fetchMock.mock.calls
      .map((call) => JSON.parse(String((call[1] as RequestInit).body)))
      .find((body) => String(body.query).includes("ConfiguredAddressGroupMembers"));
    expect(memberRequest.query).toContain("$groupIds: [String!]!");
    expect(memberRequest.variables).toMatchObject({
      registryAddress,
      groupIds: [firstGroupId, secondGroupId],
    });
  });

  it("requires every configured group to have an indexed creation event", async () => {
    mockMembershipIndexer({
      groups: [
        {
          id: `8453_${registryAddress}_${firstGroupId}`,
          chainId: 8453,
          registryAddress,
          groupId: firstGroupId,
          memberCount: 1,
        },
      ],
    });
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    await expect(
      client.getAddressGroupMembershipSnapshot({
        registryAddress,
        groupIds: [firstGroupId, secondGroupId],
        deploymentBlock: 100n,
        snapshotBlock: 120n,
      }),
    ).rejects.toThrow("Indexer has not indexed every configured group");
  });

  it("fails when group memberCount and enumerated members disagree", async () => {
    mockMembershipIndexer({
      groups: [
        {
          id: `8453_${registryAddress}_${firstGroupId}`,
          chainId: 8453,
          registryAddress,
          groupId: firstGroupId,
          memberCount: 2,
        },
        {
          id: `8453_${registryAddress}_${secondGroupId}`,
          chainId: 8453,
          registryAddress,
          groupId: secondGroupId,
          memberCount: 1,
        },
      ],
    });
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    await expect(
      client.getAddressGroupMembershipSnapshot({
        registryAddress,
        groupIds: [firstGroupId, secondGroupId],
        deploymentBlock: 100n,
        snapshotBlock: 120n,
      }),
    ).rejects.toThrow("memberCount does not match");
  });
});
