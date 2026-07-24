import { afterEach, describe, expect, it, vi } from "vitest";
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
