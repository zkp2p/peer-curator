import type { Address, Hex } from "viem";
import { type GroupId, normalizeAddress, normalizeGroupId } from "./domain.js";
import { CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET } from "./paymentMethods.js";

export interface TakerPlatformStatsRow {
  id: string;
  taker: Address;
  paymentMethodHash: Hex;
  totalAmountTaken: bigint;
}

export interface IndexedMembershipSnapshot {
  membersByGroupId: Map<GroupId, Set<Address>>;
  snapshotBlock: bigint;
  indexedThroughBlock: bigint;
}

interface GraphQlError {
  message?: string;
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: GraphQlError[];
}

interface RawTakerPlatformStats {
  id: string;
  chainId: number;
  taker: string;
  paymentMethodHash: string;
  totalAmountTaken: string;
}

interface RawAddressGroup {
  id: string;
  chainId: number;
  registryAddress: string;
  groupId: string;
  memberCount: number;
}

interface RawAddressGroupMember {
  id: string;
  chainId: number;
  registryAddress: string;
  groupId: string;
  groupEntityId: string;
  member: string;
}

interface RawChainMetadata {
  chain_id: number;
  latest_processed_block: number | null;
}

const PAGE_SIZE = 1_000;
const MAX_RETRIES = 5;
const PUBLIC_REQUEST_INTERVAL_MS = 650;

export class IndexerClient {
  private nextPublicRequestAt = 0;

  public constructor(
    private readonly url: string,
    private readonly apiKey: string | undefined,
    private readonly chainId: number,
    private readonly timeoutMs: number,
  ) {}

  private async waitForAccessSlot(): Promise<void> {
    if (this.apiKey) return;
    const now = Date.now();
    const scheduledAt = Math.max(now, this.nextPublicRequestAt);
    this.nextPublicRequestAt = scheduledAt + PUBLIC_REQUEST_INTERVAL_MS;
    const delay = scheduledAt - now;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }

  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        await this.waitForAccessSlot();
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (this.apiKey) headers["x-api-key"] = this.apiKey;
        const response = await fetch(this.url, {
          method: "POST",
          headers,
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const payload = (await response.json()) as GraphQlResponse<T>;
        if (!response.ok || payload.errors?.length || !payload.data) {
          const detail = payload.errors?.map((error) => error.message).join("; ");
          throw new Error(
            `Indexer GraphQL request failed (${response.status})${detail ? `: ${detail}` : ""}`,
          );
        }
        return payload.data;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Unknown indexer error");
        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        }
      }
    }

    throw lastError ?? new Error("Indexer request failed");
  }

  public async getIndexedThroughBlock(): Promise<bigint> {
    const query = `
      query IndexerSyncWatermark($chainId: Int!) {
        chain_metadata(
          where: { chain_id: { _eq: $chainId } }
          limit: 2
        ) {
          chain_id
          latest_processed_block
        }
      }
    `;
    const data = await this.query<{ chain_metadata: RawChainMetadata[] }>(query, {
      chainId: this.chainId,
    });
    if (!Array.isArray(data.chain_metadata) || data.chain_metadata.length !== 1) {
      throw new Error("Indexer returned an invalid chain metadata row count");
    }
    const metadata = data.chain_metadata[0];
    if (
      !metadata ||
      metadata.chain_id !== this.chainId ||
      metadata.latest_processed_block === null ||
      !Number.isSafeInteger(metadata.latest_processed_block) ||
      metadata.latest_processed_block < 0
    ) {
      throw new Error("Indexer returned invalid chain metadata");
    }
    return BigInt(metadata.latest_processed_block);
  }

  private async getConfiguredAddressGroups(input: {
    registryAddress: Address;
    groupIds: GroupId[];
  }): Promise<RawAddressGroup[]> {
    const query = `
      query ConfiguredAddressGroups(
        $chainId: Int!
        $registryAddress: String!
        $groupIds: [String!]!
        $limit: Int!
      ) {
        AddressGroup(
          where: {
            chainId: { _eq: $chainId }
            registryAddress: { _ilike: $registryAddress }
            groupId: { _in: $groupIds }
          }
          order_by: { id: asc }
          limit: $limit
        ) {
          id
          chainId
          registryAddress
          groupId
          memberCount
        }
      }
    `;
    const data = await this.query<{ AddressGroup: RawAddressGroup[] }>(query, {
      chainId: this.chainId,
      registryAddress: input.registryAddress,
      groupIds: input.groupIds,
      limit: input.groupIds.length + 1,
    });
    if (!Array.isArray(data.AddressGroup)) {
      throw new Error("Indexer response omitted AddressGroup");
    }
    return data.AddressGroup;
  }

  private async getConfiguredAddressGroupMembers(input: {
    registryAddress: Address;
    groupIds: GroupId[];
  }): Promise<RawAddressGroupMember[]> {
    const query = `
      query ConfiguredAddressGroupMembers(
        $chainId: Int!
        $registryAddress: String!
        $groupIds: [String!]!
        $after: String!
        $limit: Int!
      ) {
        AddressGroupMember(
          where: {
            chainId: { _eq: $chainId }
            registryAddress: { _ilike: $registryAddress }
            groupId: { _in: $groupIds }
            id: { _gt: $after }
          }
          order_by: { id: asc }
          limit: $limit
        ) {
          id
          chainId
          registryAddress
          groupId
          groupEntityId
          member
        }
      }
    `;

    const rows: RawAddressGroupMember[] = [];
    let after = "";
    for (;;) {
      const data = await this.query<{ AddressGroupMember: RawAddressGroupMember[] }>(query, {
        chainId: this.chainId,
        registryAddress: input.registryAddress,
        groupIds: input.groupIds,
        after,
        limit: PAGE_SIZE,
      });
      const page = data.AddressGroupMember;
      if (!Array.isArray(page)) {
        throw new Error("Indexer response omitted AddressGroupMember");
      }
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
      const next = page.at(-1)?.id;
      if (!next || next <= after) {
        throw new Error("Indexer pagination did not advance for AddressGroupMember");
      }
      after = next;
    }
    return rows;
  }

  public async getAddressGroupMembershipSnapshot(input: {
    registryAddress: Address;
    groupIds: GroupId[];
    deploymentBlock: bigint;
    snapshotBlock: bigint;
  }): Promise<IndexedMembershipSnapshot> {
    const uniqueGroupIds = [...new Set(input.groupIds)];
    if (uniqueGroupIds.length === 0) {
      throw new Error("At least one address group is required");
    }
    if (input.deploymentBlock > input.snapshotBlock) {
      throw new Error("Registry deployment block is greater than the requested chain snapshot");
    }

    const [groups, rawMembers] = await Promise.all([
      this.getConfiguredAddressGroups({
        registryAddress: input.registryAddress,
        groupIds: uniqueGroupIds,
      }),
      this.getConfiguredAddressGroupMembers({
        registryAddress: input.registryAddress,
        groupIds: uniqueGroupIds,
      }),
    ]);

    const configuredIds = new Set<GroupId>(uniqueGroupIds);
    const indexedGroups = new Map<GroupId, RawAddressGroup>();
    if (groups.length > configuredIds.size) {
      throw new Error("Indexer returned an invalid configured group row count");
    }
    for (const group of groups) {
      const registryAddress = normalizeAddress(
        group.registryAddress,
        "AddressGroup.registryAddress",
      );
      const groupId = normalizeGroupId(group.groupId, "AddressGroup.groupId");
      const expectedId = `${this.chainId}_${input.registryAddress}_${groupId}`;
      if (
        group.chainId !== this.chainId ||
        registryAddress !== input.registryAddress ||
        !configuredIds.has(groupId) ||
        group.id.toLowerCase() !== expectedId ||
        !Number.isSafeInteger(group.memberCount) ||
        group.memberCount < 0
      ) {
        throw new Error("Indexer returned an unexpected address group");
      }
      indexedGroups.set(groupId, group);
    }
    if (indexedGroups.size !== groups.length) {
      throw new Error("Indexer returned duplicate configured group rows");
    }
    if (
      indexedGroups.size !== configuredIds.size ||
      [...configuredIds].some((groupId) => !indexedGroups.has(groupId))
    ) {
      throw new Error("Indexer has not indexed every configured group from its creation event");
    }

    const membersByGroupId = new Map<GroupId, Set<Address>>(
      uniqueGroupIds.map((groupId) => [groupId, new Set<Address>()]),
    );
    const seenIds = new Set<string>();
    for (const row of rawMembers) {
      if (!row.id || seenIds.has(row.id)) {
        throw new Error("Indexer returned a duplicate or invalid address-group member id");
      }
      seenIds.add(row.id);
      const registryAddress = normalizeAddress(
        row.registryAddress,
        "AddressGroupMember.registryAddress",
      );
      const groupId = normalizeGroupId(row.groupId, "AddressGroupMember.groupId");
      const expectedGroupEntityId = `${this.chainId}_${input.registryAddress}_${groupId}`;
      if (
        row.chainId !== this.chainId ||
        registryAddress !== input.registryAddress ||
        !configuredIds.has(groupId) ||
        row.groupEntityId.toLowerCase() !== expectedGroupEntityId
      ) {
        throw new Error("Indexer returned an unexpected address-group member");
      }
      const member = normalizeAddress(row.member, "AddressGroupMember.member");
      const expectedMemberId = `${expectedGroupEntityId}_${member}`;
      if (row.id.toLowerCase() !== expectedMemberId) {
        throw new Error("Indexer returned an invalid address-group member id");
      }
      const members = membersByGroupId.get(groupId);
      if (!members) {
        throw new Error("Indexer returned a member for an unexpected group");
      }
      if (members.has(member)) {
        throw new Error("Indexer returned duplicate address-group membership");
      }
      members.add(member);
    }

    for (const groupId of uniqueGroupIds) {
      const indexedCount = indexedGroups.get(groupId)?.memberCount;
      const enumeratedCount = membersByGroupId.get(groupId)?.size;
      if (
        indexedCount === undefined ||
        enumeratedCount === undefined ||
        indexedCount !== enumeratedCount
      ) {
        throw new Error("Indexer AddressGroup.memberCount does not match AddressGroupMember rows");
      }
    }

    return {
      membersByGroupId,
      snapshotBlock: input.snapshotBlock,
      indexedThroughBlock: input.snapshotBlock,
    };
  }

  public async getTakerPlatformStats(
    paymentMethodHashes: ReadonlySet<Hex>,
  ): Promise<TakerPlatformStatsRow[]> {
    if (paymentMethodHashes.size === 0) {
      throw new Error("At least one chargebackable payment-method hash is required");
    }
    const configuredHashes = [...paymentMethodHashes];
    if (
      configuredHashes.some((hash) => !/^0x[0-9a-f]{64}$/.test(hash)) ||
      configuredHashes.length !== CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET.size ||
      configuredHashes.some((hash) => !CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET.has(hash))
    ) {
      throw new Error("Chargebackable payment-method hashes are invalid or unknown");
    }

    const query = `
      query TakerPlatformStatsPage(
        $chainId: Int!
        $paymentMethodHashes: [String!]!
        $after: String!
        $limit: Int!
      ) {
        TakerPlatformStats(
          where: {
            chainId: { _eq: $chainId }
            paymentMethodHash: { _in: $paymentMethodHashes }
            id: { _gt: $after }
          }
          order_by: { id: asc }
          limit: $limit
        ) {
          id
          chainId
          taker
          paymentMethodHash
          totalAmountTaken
        }
      }
    `;

    const rawRows: RawTakerPlatformStats[] = [];
    let after = "";
    for (;;) {
      const data = await this.query<{ TakerPlatformStats: RawTakerPlatformStats[] }>(query, {
        chainId: this.chainId,
        paymentMethodHashes: configuredHashes,
        after,
        limit: PAGE_SIZE,
      });
      const page = data.TakerPlatformStats;
      if (!Array.isArray(page)) {
        throw new Error("Indexer response omitted TakerPlatformStats");
      }
      let previousId = after;
      for (const row of page) {
        if (typeof row.id !== "string" || row.id <= previousId) {
          throw new Error("Indexer returned duplicate or non-ascending TakerPlatformStats ids");
        }
        previousId = row.id;
      }
      rawRows.push(...page);
      if (page.length < PAGE_SIZE) break;
      const next = page.at(-1)?.id;
      if (!next || next <= after) {
        throw new Error("Indexer pagination did not advance for TakerPlatformStats");
      }
      after = next;
    }

    if (new Set(rawRows.map((row) => row.id)).size !== rawRows.length) {
      throw new Error("Indexer returned duplicate TakerPlatformStats rows");
    }

    return rawRows.map((row) => {
      const taker = normalizeAddress(row.taker, "TakerPlatformStats.taker");
      const paymentMethodHash = row.paymentMethodHash?.toLowerCase() as Hex;
      if (
        row.chainId !== this.chainId ||
        !/^0x[0-9a-f]{64}$/.test(paymentMethodHash) ||
        !paymentMethodHashes.has(paymentMethodHash)
      ) {
        throw new Error("Indexer returned an unexpected TakerPlatformStats row");
      }
      if (row.id.toLowerCase() !== `${this.chainId}_${taker}_${paymentMethodHash}`) {
        throw new Error("Indexer returned an invalid TakerPlatformStats id");
      }
      if (typeof row.totalAmountTaken !== "string" || !/^\d+$/.test(row.totalAmountTaken)) {
        throw new Error("Indexer returned invalid TakerPlatformStats.totalAmountTaken");
      }
      const totalAmountTaken = BigInt(row.totalAmountTaken);
      if (totalAmountTaken < 0n) {
        throw new Error("Indexer returned negative TakerPlatformStats.totalAmountTaken");
      }
      return {
        id: row.id,
        taker,
        paymentMethodHash,
        totalAmountTaken,
      };
    });
  }
}
