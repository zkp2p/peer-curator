import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeAddress } from "../src/domain.js";
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

  function mockMembershipIndexer(options?: {
    indexedThroughBlock?: number;
    groups?: unknown[];
    events?: unknown[];
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
            [1n, 2n].map((groupId) => ({
              id: `8453_${registryAddress}_${groupId}`,
              chainId: 8453,
              registryAddress: registryAddress.toUpperCase(),
              groupId: groupId.toString(),
            })),
        };
      } else if (body.query.includes("AddressGroupMembershipEvents")) {
        data = {
          AddressGroupMembershipEvent: options?.events ?? [
            {
              id: "event-remove",
              chainId: 8453,
              registryAddress,
              groupId: "1",
              member: firstMember,
              present: false,
              blockNumber: "110",
              logIndex: "3",
            },
            {
              id: "event-add",
              chainId: 8453,
              registryAddress,
              groupId: "2",
              member: secondMember,
              present: true,
              blockNumber: "105",
              logIndex: "7",
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

  it("reads a watermark and validates a bounded membership snapshot", async () => {
    const fetchMock = mockMembershipIndexer();
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    const snapshot = await client.getAddressGroupMembershipSnapshot({
      registryAddress,
      groupIds: [1n, 2n],
      deploymentBlock: 100n,
      snapshotBlock: 115n,
    });

    expect(snapshot.indexedThroughBlock).toBe(120n);
    expect(snapshot.snapshotBlock).toBe(115n);
    expect(snapshot.events).toEqual([
      expect.objectContaining({
        groupId: 1n,
        member: normalizeAddress(firstMember),
        present: false,
        blockNumber: 110n,
        logIndex: 3n,
      }),
      expect.objectContaining({
        groupId: 2n,
        member: normalizeAddress(secondMember),
        present: true,
        blockNumber: 105n,
        logIndex: 7n,
      }),
    ]);

    const eventRequest = fetchMock.mock.calls
      .map((call) => JSON.parse(String((call[1] as RequestInit).body)))
      .find((body) => String(body.query).includes("AddressGroupMembershipEvents"));
    expect(eventRequest.query).toContain("$throughBlock: numeric!");
    expect(eventRequest.query).toContain("$groupIds: [numeric!]!");
    expect(eventRequest.variables).toMatchObject({
      registryAddress,
      groupIds: ["1", "2"],
      deploymentBlock: "100",
      throughBlock: "115",
    });
  });

  it("fails before reading membership when the indexer is behind", async () => {
    const fetchMock = mockMembershipIndexer({ indexedThroughBlock: 114 });
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    await expect(
      client.getAddressGroupMembershipSnapshot({
        registryAddress,
        groupIds: [1n, 2n],
        deploymentBlock: 100n,
        snapshotBlock: 115n,
      }),
    ).rejects.toThrow("Indexer has not processed the requested chain snapshot");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires every configured group to have an indexed creation event", async () => {
    mockMembershipIndexer({
      groups: [
        {
          id: `8453_${registryAddress}_1`,
          chainId: 8453,
          registryAddress,
          groupId: "1",
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
        groupIds: [1n, 2n],
        deploymentBlock: 100n,
        snapshotBlock: 115n,
      }),
    ).rejects.toThrow("Indexer has not indexed every configured group");
  });

  it("rejects duplicate block and log coordinates", async () => {
    mockMembershipIndexer({
      events: [
        {
          id: "event-one",
          chainId: 8453,
          registryAddress,
          groupId: "1",
          member: firstMember,
          present: true,
          blockNumber: "110",
          logIndex: "3",
        },
        {
          id: "event-two",
          chainId: 8453,
          registryAddress,
          groupId: "2",
          member: secondMember,
          present: true,
          blockNumber: "110",
          logIndex: "3",
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
        groupIds: [1n, 2n],
        deploymentBlock: 100n,
        snapshotBlock: 115n,
      }),
    ).rejects.toThrow("duplicate membership event ordering coordinates");
  });
});
