import type { Address } from "viem";
import { normalizeAddress } from "./domain.js";

export interface TakerStatsRow {
  id: string;
  owner: Address;
  totalFulfilledVolume: bigint;
  lockScore: bigint;
}

export interface MakerPlatformStatsRow {
  id: string;
  maker: Address;
  paymentMethodHash: string;
  totalAmountTakenPreEarnCutover: bigint;
}

export interface MakerPeerPayStatsRow {
  id: string;
  maker: Address;
  ppTakenPostEarnCutover: bigint;
}

export interface IndexedMembershipEvent {
  id: string;
  chainId: number;
  registryAddress: Address;
  groupId: bigint;
  member: Address;
  present: boolean;
  blockNumber: bigint;
  logIndex: bigint;
}

export interface IndexedMembershipSnapshot {
  events: IndexedMembershipEvent[];
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

interface RawTakerStats {
  id: string;
  owner: string;
  totalFulfilledVolume: string;
  lockScore: string;
}

interface RawMakerPlatformStats {
  id: string;
  maker: string;
  paymentMethodHash: string;
  totalAmountTakenPreEarnCutover: string;
}

interface RawMakerPeerPayStats {
  id: string;
  maker: string;
  ppTakenPostEarnCutover: string;
}

interface RawMembershipEvent {
  id: string;
  chainId: number;
  registryAddress: string;
  groupId: string;
  member: string;
  present: boolean;
  blockNumber: string;
  logIndex: string;
}

interface RawAddressGroup {
  id: string;
  chainId: number;
  registryAddress: string;
  groupId: string;
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

  private async pageAll<T extends { id: string }>(entity: string, fields: string): Promise<T[]> {
    const query = `
      query Page($chainId: Int!, $after: String!, $limit: Int!) {
        ${entity}(
          where: { chainId: { _eq: $chainId }, id: { _gt: $after } }
          order_by: { id: asc }
          limit: $limit
        ) {
          ${fields}
        }
      }
    `;

    const rows: T[] = [];
    let after = "";
    for (;;) {
      const data = await this.query<Record<string, T[]>>(query, {
        chainId: this.chainId,
        after,
        limit: PAGE_SIZE,
      });
      const page = data[entity];
      if (!page) {
        throw new Error(`Indexer response omitted ${entity}`);
      }
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
      const next = page.at(-1)?.id;
      if (!next || next <= after) {
        throw new Error(`Indexer pagination did not advance for ${entity}`);
      }
      after = next;
    }

    if (new Set(rows.map((row) => row.id)).size !== rows.length) {
      throw new Error(`Indexer returned duplicate ${entity} rows`);
    }
    return rows;
  }

  private async getIndexedThroughBlock(): Promise<bigint> {
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
    groupIds: bigint[];
  }): Promise<RawAddressGroup[]> {
    const query = `
      query ConfiguredAddressGroups(
        $chainId: Int!
        $registryAddress: String!
        $groupIds: [numeric!]!
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
        }
      }
    `;
    const data = await this.query<{ AddressGroup: RawAddressGroup[] }>(query, {
      chainId: this.chainId,
      registryAddress: input.registryAddress,
      groupIds: input.groupIds.map(String),
      limit: input.groupIds.length + 1,
    });
    if (!Array.isArray(data.AddressGroup)) {
      throw new Error("Indexer response omitted AddressGroup");
    }
    return data.AddressGroup;
  }

  private async getMembershipEvents(input: {
    registryAddress: Address;
    groupIds: bigint[];
    deploymentBlock: bigint;
    throughBlock: bigint;
  }): Promise<RawMembershipEvent[]> {
    const query = `
      query AddressGroupMembershipEvents(
        $chainId: Int!
        $registryAddress: String!
        $groupIds: [numeric!]!
        $deploymentBlock: numeric!
        $throughBlock: numeric!
        $after: String!
        $limit: Int!
      ) {
        AddressGroupMembershipEvent(
          where: {
            chainId: { _eq: $chainId }
            registryAddress: { _ilike: $registryAddress }
            groupId: { _in: $groupIds }
            blockNumber: { _gte: $deploymentBlock, _lte: $throughBlock }
            id: { _gt: $after }
          }
          order_by: { id: asc }
          limit: $limit
        ) {
          id
          chainId
          registryAddress
          groupId
          member
          present
          blockNumber
          logIndex
        }
      }
    `;

    const rows: RawMembershipEvent[] = [];
    let after = "";
    for (;;) {
      const data = await this.query<{ AddressGroupMembershipEvent: RawMembershipEvent[] }>(query, {
        chainId: this.chainId,
        registryAddress: input.registryAddress,
        groupIds: input.groupIds.map(String),
        deploymentBlock: input.deploymentBlock.toString(),
        throughBlock: input.throughBlock.toString(),
        after,
        limit: PAGE_SIZE,
      });
      const page = data.AddressGroupMembershipEvent;
      if (!Array.isArray(page)) {
        throw new Error("Indexer response omitted AddressGroupMembershipEvent");
      }
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
      const next = page.at(-1)?.id;
      if (!next || next <= after) {
        throw new Error("Indexer pagination did not advance for AddressGroupMembershipEvent");
      }
      after = next;
    }
    return rows;
  }

  public async getAddressGroupMembershipSnapshot(input: {
    registryAddress: Address;
    groupIds: bigint[];
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

    const indexedThroughBlock = await this.getIndexedThroughBlock();
    if (indexedThroughBlock < input.snapshotBlock) {
      throw new Error("Indexer has not processed the requested chain snapshot");
    }

    const [groups, rawEvents] = await Promise.all([
      this.getConfiguredAddressGroups({
        registryAddress: input.registryAddress,
        groupIds: uniqueGroupIds,
      }),
      this.getMembershipEvents({
        registryAddress: input.registryAddress,
        groupIds: uniqueGroupIds,
        deploymentBlock: input.deploymentBlock,
        throughBlock: input.snapshotBlock,
      }),
    ]);

    const configuredIds = new Set(uniqueGroupIds.map(String));
    const indexedGroupIds = new Set<string>();
    if (groups.length > configuredIds.size) {
      throw new Error("Indexer returned an invalid configured group row count");
    }
    for (const group of groups) {
      const registryAddress = normalizeAddress(
        group.registryAddress,
        "AddressGroup.registryAddress",
      );
      const groupId = parseUnsignedBigInt(group.groupId, "AddressGroup.groupId");
      if (
        group.chainId !== this.chainId ||
        registryAddress !== input.registryAddress ||
        !configuredIds.has(groupId.toString())
      ) {
        throw new Error("Indexer returned an unexpected address group");
      }
      indexedGroupIds.add(groupId.toString());
    }
    if (indexedGroupIds.size !== groups.length) {
      throw new Error("Indexer returned duplicate configured group rows");
    }
    if (
      indexedGroupIds.size !== configuredIds.size ||
      [...configuredIds].some((groupId) => !indexedGroupIds.has(groupId))
    ) {
      throw new Error("Indexer has not indexed every configured group from its creation event");
    }

    const seenIds = new Set<string>();
    const seenPositions = new Set<string>();
    const events = rawEvents.map((row): IndexedMembershipEvent => {
      if (!row.id || seenIds.has(row.id)) {
        throw new Error("Indexer returned a duplicate or invalid membership event id");
      }
      seenIds.add(row.id);
      const registryAddress = normalizeAddress(
        row.registryAddress,
        "AddressGroupMembershipEvent.registryAddress",
      );
      const groupId = parseUnsignedBigInt(row.groupId, "AddressGroupMembershipEvent.groupId");
      const blockNumber = parseUnsignedBigInt(
        row.blockNumber,
        "AddressGroupMembershipEvent.blockNumber",
      );
      const logIndex = parseUnsignedBigInt(row.logIndex, "AddressGroupMembershipEvent.logIndex");
      if (
        row.chainId !== this.chainId ||
        registryAddress !== input.registryAddress ||
        !configuredIds.has(groupId.toString()) ||
        blockNumber < input.deploymentBlock ||
        blockNumber > input.snapshotBlock ||
        typeof row.present !== "boolean"
      ) {
        throw new Error("Indexer returned an unexpected membership event");
      }
      const position = `${blockNumber}:${logIndex}`;
      if (seenPositions.has(position)) {
        throw new Error("Indexer returned duplicate membership event ordering coordinates");
      }
      seenPositions.add(position);
      return {
        id: row.id,
        chainId: row.chainId,
        registryAddress,
        groupId,
        member: normalizeAddress(row.member, "AddressGroupMembershipEvent.member"),
        present: row.present,
        blockNumber,
        logIndex,
      };
    });

    return {
      events,
      snapshotBlock: input.snapshotBlock,
      indexedThroughBlock,
    };
  }

  public async getTakerStats(): Promise<TakerStatsRow[]> {
    const rows = await this.pageAll<RawTakerStats>(
      "TakerStats",
      "id owner totalFulfilledVolume lockScore",
    );
    return rows.map((row) => ({
      id: row.id,
      owner: normalizeAddress(row.owner, "TakerStats.owner"),
      totalFulfilledVolume: BigInt(row.totalFulfilledVolume),
      lockScore: BigInt(row.lockScore),
    }));
  }

  public async getMakerPlatformStats(): Promise<MakerPlatformStatsRow[]> {
    const rows = await this.pageAll<RawMakerPlatformStats>(
      "MakerPlatformStats",
      "id maker paymentMethodHash totalAmountTakenPreEarnCutover",
    );
    return rows.map((row) => ({
      id: row.id,
      maker: normalizeAddress(row.maker, "MakerPlatformStats.maker"),
      paymentMethodHash: row.paymentMethodHash.toLowerCase(),
      totalAmountTakenPreEarnCutover: BigInt(row.totalAmountTakenPreEarnCutover),
    }));
  }

  public async getMakerPeerPayStats(): Promise<MakerPeerPayStatsRow[]> {
    const rows = await this.pageAll<RawMakerPeerPayStats>(
      "MakerPeerPayStats",
      "id maker ppTakenPostEarnCutover",
    );
    return rows.map((row) => ({
      id: row.id,
      maker: normalizeAddress(row.maker, "MakerPeerPayStats.maker"),
      ppTakenPostEarnCutover: BigInt(row.ppTakenPostEarnCutover),
    }));
  }
}

function parseUnsignedBigInt(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`Indexer returned invalid ${label}`);
  }
  return BigInt(value);
}
