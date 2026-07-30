import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("IndexerClient atomic reconciliation snapshot", () => {
  const registryAddress = normalizeAddress("0x9999999999999999999999999999999999999999");
  const groupId = normalizeGroupId(`0x${"11".repeat(32)}`);
  const member = normalizeAddress("0x2222222222222222222222222222222222222222");
  const platformRow = {
    id: `8453_${taker}_${paypalHash}`,
    chainId: 8453,
    taker,
    paymentMethodHash: paypalHash,
    totalAmountTaken: "500000000",
  };
  const groupRow = {
    id: `8453_${registryAddress}_${groupId}`,
    chainId: 8453,
    registryAddress,
    groupId,
    memberCount: 1,
  };
  const memberRow = {
    id: `8453_${registryAddress}_${groupId}_${member}`,
    chainId: 8453,
    registryAddress,
    groupId,
    groupEntityId: `8453_${registryAddress}_${groupId}`,
    member,
  };

  function atomicPayload(input?: {
    nonContiguousPlatformPage?: boolean;
    platformOverflow?: boolean;
  }): Record<string, unknown> {
    const data: Record<string, unknown> = {
      chain_metadata: [{ chain_id: 8453, latest_processed_block: 120 }],
      AddressGroup: [groupRow],
    };
    for (let index = 0; index < 11; index += 1) {
      data[`platformPage${index}`] =
        index === 0 ||
        (index === 1 && input?.nonContiguousPlatformPage) ||
        (index === 10 && input?.platformOverflow)
          ? [platformRow]
          : [];
    }
    for (let index = 0; index < 6; index += 1) {
      data[`memberPage${index}`] = index === 0 ? [memberRow] : [];
    }
    return data;
  }

  it("reads watermark, aggregates, groups, and members in one GraphQL request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: atomicPayload() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    const snapshot = await client.getAtomicReconciliationSnapshot({
      registryAddress,
      groupIds: [groupId],
      deploymentBlock: 100n,
      paymentMethodHashes: CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(snapshot.membership.snapshotBlock).toBe(120n);
    expect(snapshot.membership.membersByGroupId.get(groupId)).toEqual(new Set([member]));
    expect(snapshot.takerPlatformStats).toHaveLength(1);
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error("Expected one GraphQL request");
    const request = JSON.parse(String((firstCall[1] as RequestInit).body));
    expect(request.query).toContain("AtomicReconciliationSnapshot");
    expect(request.query).toContain("platformPage10:");
    expect(request.query).toContain("memberPage5:");
    expect(request.query).toContain("chain_metadata");
  });

  it("fails closed when a page appears after an earlier short page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: atomicPayload({ nonContiguousPlatformPage: true }),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    const client = new IndexerClient(
      "https://indexer.example/graphql",
      "test-api-key",
      8453,
      1_000,
    );

    await expect(
      client.getAtomicReconciliationSnapshot({
        registryAddress,
        groupIds: [groupId],
        deploymentBlock: 100n,
        paymentMethodHashes: CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET,
      }),
    ).rejects.toThrow("non-contiguous TakerPlatformStats pages");
  });

  it("fails closed when the explicit overflow page is nonempty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: atomicPayload({ platformOverflow: true }) }), {
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
      client.getAtomicReconciliationSnapshot({
        registryAddress,
        groupIds: [groupId],
        deploymentBlock: 100n,
        paymentMethodHashes: CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET,
      }),
    ).rejects.toThrow("TakerPlatformStats safety limit");
  });
});
