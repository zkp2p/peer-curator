import { afterEach, describe, expect, it, vi } from "vitest";
import { getV2ChargebackVerifierMap } from "../src/blockPinnedSnapshot.js";
import { normalizeAddress, normalizeGroupId } from "../src/domain.js";
import { IndexerClient } from "../src/indexer.js";
import {
  CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET,
  CHARGEBACKABLE_PAYMENT_METHOD_HASHES,
} from "../src/paymentMethods.js";

const taker = "0x1111111111111111111111111111111111111111";
const paypalHash = CHARGEBACKABLE_PAYMENT_METHOD_HASHES.paypal;
const takerPlatformStatsResponse = {
  data: {
    TakerPlatformStats: [
      {
        id: `8453_${taker}_${paypalHash}`,
        chainId: 8453,
        taker,
        paymentMethodHash: paypalHash,
        totalAmountTaken: "500000000",
      },
    ],
  },
};

function mockIndexer(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(takerPlatformStatsResponse), {
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

    await client.getTakerPlatformStats(CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET);

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

    await client.getTakerPlatformStats(CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET);

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-api-key");
  });
});

describe("IndexerClient taker-platform pagination and validation", () => {
  function rawPlatformRow(input: {
    taker: string;
    paymentMethodHash?: string;
    totalAmountTaken?: unknown;
    id?: string;
  }) {
    const paymentMethodHash = input.paymentMethodHash ?? paypalHash;
    return {
      id: input.id ?? `8453_${input.taker}_${paymentMethodHash}`,
      chainId: 8453,
      taker: input.taker,
      paymentMethodHash,
      totalAmountTaken: input.totalAmountTaken ?? "1",
    };
  }

  it("paginates deterministically and aggregates no rows in the client", async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) => {
      const pageTaker = `0x${(index + 1).toString(16).padStart(40, "0")}`;
      return rawPlatformRow({ taker: pageTaker });
    });
    const finalTaker = "0xffffffffffffffffffffffffffffffffffffffff";
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        variables: { after: string };
      };
      const page = body.variables.after ? [rawPlatformRow({ taker: finalTaker })] : firstPage;
      return new Response(JSON.stringify({ data: { TakerPlatformStats: page } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    const rows = await client.getTakerPlatformStats(CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET);

    expect(rows).toHaveLength(1_001);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondRequest = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
    );
    expect(secondRequest.variables.after).toBe(firstPage.at(-1)?.id);
  });

  it("fails closed on duplicate row ids", async () => {
    const row = rawPlatformRow({ taker });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { TakerPlatformStats: [row, row] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    await expect(
      client.getTakerPlatformStats(CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET),
    ).rejects.toThrow("duplicate or non-ascending TakerPlatformStats");
  });

  it("fails closed on duplicate tuples whose ids differ only by casing", async () => {
    const lowercaseTaker = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const uppercaseTaker = lowercaseTaker.toUpperCase().replace("0X", "0x");
    const uppercaseHash = paypalHash.toUpperCase().replace("0X", "0x");
    const rows = [
      rawPlatformRow({
        taker: uppercaseTaker,
        paymentMethodHash: uppercaseHash,
      }),
      rawPlatformRow({
        taker: lowercaseTaker,
        paymentMethodHash: paypalHash,
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { TakerPlatformStats: rows } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    await expect(
      client.getTakerPlatformStats(CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET),
    ).rejects.toThrow("duplicate canonical TakerPlatformStats");
  });

  it("fails closed when pagination does not advance", async () => {
    const page = Array.from({ length: 1_000 }, (_, index) => {
      const pageTaker = `0x${(index + 1).toString(16).padStart(40, "0")}`;
      return rawPlatformRow({ taker: pageTaker });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify({ data: { TakerPlatformStats: page } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    await expect(
      client.getTakerPlatformStats(CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET),
    ).rejects.toThrow("duplicate or non-ascending");
  });

  it("rejects an unknown configured chargebackable hash before querying", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    const unknownHashes = new Set<`0x${string}`>([`0x${"99".repeat(32)}` as `0x${string}`]);
    await expect(client.getTakerPlatformStats(unknownHashes)).rejects.toThrow("invalid or unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing rows", { data: {} }, "omitted TakerPlatformStats"],
    [
      "invalid address",
      {
        data: {
          TakerPlatformStats: [rawPlatformRow({ taker: "not-an-address" })],
        },
      },
      "Invalid TakerPlatformStats.taker",
    ],
    [
      "unexpected hash",
      {
        data: {
          TakerPlatformStats: [
            rawPlatformRow({
              taker,
              paymentMethodHash: `0x${"99".repeat(32)}`,
            }),
          ],
        },
      },
      "unexpected TakerPlatformStats",
    ],
    [
      "invalid amount",
      {
        data: {
          TakerPlatformStats: [rawPlatformRow({ taker, totalAmountTaken: "1.5" })],
        },
      },
      "invalid TakerPlatformStats.totalAmountTaken",
    ],
  ])("fails closed on %s", async (_label, payload, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    await expect(
      client.getTakerPlatformStats(CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET),
    ).rejects.toThrow(message);
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

describe("IndexerClient block-pinned reconciliation snapshot", () => {
  const registryAddress = normalizeAddress("0x9999999999999999999999999999999999999999");
  const groupId = normalizeGroupId(`0x${"11".repeat(32)}`);
  const member = normalizeAddress("0x2222222222222222222222222222222222222222");
  const snapshotBlock = 49_000_000n;
  const intentHash = `0x${"33".repeat(32)}`;
  const v2Verifier = [...getV2ChargebackVerifierMap("prod").keys()][0];
  if (!v2Verifier) throw new Error("Missing fixture V2 verifier");

  function pinnedFetch(input?: { outOfRange?: boolean }): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const id = input?.outOfRange ? "8453_49000001_1" : "8453_48999999_1";
      let rows: Record<string, unknown>[] = [];
      if (request.query.includes("Escrow_V2_IntentSignaled")) {
        rows = [
          {
            id,
            intentHash,
            verifier: v2Verifier,
            owner: taker,
          },
        ];
      } else if (request.query.includes("Escrow_V2_IntentFulfilled")) {
        rows = [{ id: "8453_48999999_2", intentHash, owner: taker, amount: "500000000" }];
      } else if (request.query.includes("AddressGroupRegistry_GroupCreated")) {
        rows = [{ id: "8453_48999998_1", groupId }];
      } else if (request.query.includes("AddressGroupRegistry_MemberAdded")) {
        rows = [{ id: "8453_48999999_3", groupId, member }];
      } else if (request.query.includes("GroupRegistryBinding")) {
        return new Response(
          JSON.stringify({
            data: {
              AddressGroup: [
                {
                  id: `8453_${registryAddress}_${groupId}`,
                  chainId: 8453,
                  registryAddress,
                  groupId,
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: { rows } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("constrains every immutable event query to one explicit block", async () => {
    const fetchMock = pinnedFetch();
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    const snapshot = await client.getBlockPinnedReconciliationSnapshot({
      registryAddress,
      groupIds: [groupId],
      deploymentBlock: 48_000_000n,
      paymentMethodHashes: CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET,
      snapshotBlock,
      v2Environment: "prod",
    });

    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(snapshot.membership.snapshotBlock).toBe(snapshotBlock);
    expect(snapshot.membership.membersByGroupId.get(groupId)).toEqual(new Set([member]));
    expect(snapshot.takerPlatformStats).toHaveLength(1);
    for (const call of fetchMock.mock.calls.slice(0, 7)) {
      const request = JSON.parse(String((call[1] as RequestInit).body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      expect(request.query).toContain("id: { _gt: $after, _lte: $through }");
      expect(request.variables.through).toBe("8453_49000000_999999999");
    }
    expect(snapshot.evidenceDigest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("fails closed if an indexer returns an event beyond the chosen block", async () => {
    pinnedFetch({ outOfRange: true });
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    await expect(
      client.getBlockPinnedReconciliationSnapshot({
        registryAddress,
        groupIds: [groupId],
        deploymentBlock: 48_000_000n,
        paymentMethodHashes: CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET,
        snapshotBlock,
        v2Environment: "prod",
      }),
    ).rejects.toThrow("outside the requested block snapshot");
  });

  it("rejects snapshots outside the event-id ordering window", async () => {
    pinnedFetch();
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    await expect(
      client.getBlockPinnedReconciliationSnapshot({
        registryAddress,
        groupIds: [groupId],
        deploymentBlock: 100n,
        paymentMethodHashes: CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET,
        snapshotBlock: 120n,
        v2Environment: "prod",
      }),
    ).rejects.toThrow("outside the fail-closed Base event-id ordering window");
  });

  it("fails closed when group ids are projected under another registry", async () => {
    const fetchMock = pinnedFetch();
    fetchMock.mockImplementation(async (_url, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { query: string };
      if (request.query.includes("GroupRegistryBinding")) {
        return new Response(
          JSON.stringify({
            data: {
              AddressGroup: [
                {
                  id: `8453_0x8888888888888888888888888888888888888888_${groupId}`,
                  chainId: 8453,
                  registryAddress: "0x8888888888888888888888888888888888888888",
                  groupId,
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: { rows: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );
    await expect(
      client.getBlockPinnedReconciliationSnapshot({
        registryAddress,
        groupIds: [groupId],
        deploymentBlock: 48_000_000n,
        paymentMethodHashes: CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET,
        snapshotBlock,
        v2Environment: "prod",
      }),
    ).rejects.toThrow("unexpected registry");
  });
});
