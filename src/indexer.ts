import { createHash } from "node:crypto";
import type { Address, Hex } from "viem";
import {
  buildPinnedEventIdBounds,
  type RawDepositMaker,
  type RawGroupCreatedEvent,
  type RawMemberEvent,
  type RawUnifiedIntentFulfilled,
  type RawUnifiedIntentSignaled,
  type RawUnifiedMerchantIntentFulfilled,
  type RawUnifiedMerchantIntentSignaled,
  type RawV2IntentFulfilled,
  type RawV2IntentSignaled,
  type RawV2MerchantIntentFulfilled,
  type RawV2MerchantIntentSignaled,
  reconstructMembership,
  reconstructMerchantPlatformRows,
  reconstructPlatformRows,
  V2_HISTORY_ESCROW_BY_ENVIRONMENT,
  type V2HistoryEnvironment,
} from "./blockPinnedSnapshot.js";
import { type GroupId, normalizeAddress, normalizeGroupId } from "./domain.js";
import { CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET } from "./paymentMethods.js";

export interface TakerPlatformStatsRow {
  id: string;
  taker: Address;
  paymentMethodHash: Hex;
  totalAmountTaken: bigint;
}

export interface MakerPlatformStatsRow {
  id: string;
  maker: Address;
  paymentMethodHash: Hex;
  totalAmountTaken: bigint;
  nonManualReleaseVolume: bigint;
  manualReleaseVolume: bigint;
}

export interface IndexedMembershipSnapshot {
  membersByGroupId: Map<GroupId, Set<Address>>;
  snapshotBlock: bigint;
  indexedThroughBlock: bigint;
}

export interface BlockPinnedReconciliationSnapshot {
  takerPlatformStats: TakerPlatformStatsRow[];
  membership: IndexedMembershipSnapshot;
  evidenceDigest: Hex;
}

export interface BlockPinnedMembershipSnapshot {
  membership: IndexedMembershipSnapshot;
  evidenceDigest: Hex;
}

export interface BlockPinnedMerchantSnapshot {
  makerPlatformStats: MakerPlatformStatsRow[];
  evidenceDigest: Hex;
  snapshotBlock: bigint;
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

interface RawMakerPlatformStats {
  id: string;
  chainId: number;
  maker: string;
  paymentMethodHash: string;
  totalAmountTaken: string;
  nonManualReleaseVolume: string;
  manualReleaseVolume: string;
}

interface RawAddressGroup {
  id: string;
  chainId: number;
  registryAddress: string;
  groupId: string;
  memberCount: number;
}

interface RawAddressGroupBinding {
  id: string;
  chainId: number;
  registryAddress: string;
  groupId: string;
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
const MAX_V2_SIGNAL_ROWS = 25_000;
const MAX_V2_FULFILLMENT_ROWS = 25_000;
const MAX_UNIFIED_SIGNAL_ROWS = 100_000;
const MAX_UNIFIED_FULFILLMENT_ROWS = 100_000;
const MAX_GROUP_EVENT_ROWS = 10_000;
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

  private async getGroupBindingRows(groupIds: GroupId[]): Promise<RawAddressGroupBinding[]> {
    const query = `
      query GroupRegistryBinding(
        $chainId: Int!
        $groupIds: [String!]!
        $limit: Int!
      ) {
        AddressGroup(
          where: {
            chainId: { _eq: $chainId }
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
    const data = await this.query<{ AddressGroup: RawAddressGroupBinding[] }>(query, {
      chainId: this.chainId,
      groupIds,
      limit: groupIds.length + 1,
    });
    if (!Array.isArray(data.AddressGroup)) {
      throw new Error("Indexer response omitted the group registry binding");
    }
    return data.AddressGroup;
  }

  private assertGroupRegistryBinding(input: {
    registryAddress: Address;
    groupIds: GroupId[];
    rows: RawAddressGroupBinding[];
  }): void {
    if (input.rows.length !== input.groupIds.length) {
      throw new Error("Indexer group projection does not uniquely bind the configured registry");
    }
    const expectedGroupIds = new Set(input.groupIds);
    const seenGroupIds = new Set<GroupId>();
    for (const row of input.rows) {
      const registryAddress = normalizeAddress(row.registryAddress, "AddressGroup.registryAddress");
      const groupId = normalizeGroupId(row.groupId, "AddressGroup.groupId");
      const expectedId = `${this.chainId}_${input.registryAddress}_${groupId}`;
      if (
        row.chainId !== this.chainId ||
        registryAddress !== input.registryAddress ||
        !expectedGroupIds.has(groupId) ||
        row.id.toLowerCase() !== expectedId
      ) {
        throw new Error("Indexer group projection is bound to an unexpected registry");
      }
      if (seenGroupIds.has(groupId)) {
        throw new Error("Indexer group projection contains a duplicate group binding");
      }
      seenGroupIds.add(groupId);
    }
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

  private buildMembershipSnapshot(input: {
    registryAddress: Address;
    groupIds: GroupId[];
    deploymentBlock: bigint;
    snapshotBlock: bigint;
    groups: RawAddressGroup[];
    rawMembers: RawAddressGroupMember[];
  }): IndexedMembershipSnapshot {
    const uniqueGroupIds = [...new Set(input.groupIds)];
    if (uniqueGroupIds.length === 0) {
      throw new Error("At least one address group is required");
    }
    if (input.deploymentBlock > input.snapshotBlock) {
      throw new Error("Registry deployment block is greater than the requested chain snapshot");
    }

    const configuredIds = new Set<GroupId>(uniqueGroupIds);
    const indexedGroups = new Map<GroupId, RawAddressGroup>();
    if (input.groups.length > configuredIds.size) {
      throw new Error("Indexer returned an invalid configured group row count");
    }
    for (const group of input.groups) {
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
    if (indexedGroups.size !== input.groups.length) {
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
    for (const row of input.rawMembers) {
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

    return this.buildMembershipSnapshot({
      ...input,
      groupIds: uniqueGroupIds,
      groups,
      rawMembers,
    });
  }

  private validatePaymentMethodHashes(paymentMethodHashes: ReadonlySet<Hex>): Hex[] {
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
    return configuredHashes;
  }

  private parseTakerPlatformStatsRows(
    rawRows: RawTakerPlatformStats[],
    paymentMethodHashes: ReadonlySet<Hex>,
  ): TakerPlatformStatsRow[] {
    if (new Set(rawRows.map((row) => row.id)).size !== rawRows.length) {
      throw new Error("Indexer returned duplicate TakerPlatformStats rows");
    }

    const rows = rawRows.map((row) => {
      const taker = normalizeAddress(row.taker, "TakerPlatformStats.taker");
      const paymentMethodHash = row.paymentMethodHash?.toLowerCase() as Hex;
      if (
        row.chainId !== this.chainId ||
        !/^0x[0-9a-f]{64}$/.test(paymentMethodHash) ||
        !paymentMethodHashes.has(paymentMethodHash)
      ) {
        throw new Error("Indexer returned an unexpected TakerPlatformStats row");
      }
      const canonicalId = `${this.chainId}_${taker}_${paymentMethodHash}`;
      if (row.id.toLowerCase() !== canonicalId) {
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
        id: canonicalId,
        taker,
        paymentMethodHash,
        totalAmountTaken,
      };
    });
    if (new Set(rows.map((row) => row.id)).size !== rows.length) {
      throw new Error("Indexer returned duplicate canonical TakerPlatformStats rows");
    }
    return rows;
  }

  private async getPinnedEventRows<T extends { id: string }>(input: {
    root: string;
    selection: string;
    snapshotBlock: bigint;
    maximumRows: number;
    additionalWhere?: string;
    variables?: Record<string, unknown>;
    variableDefinitions?: string;
  }): Promise<T[]> {
    const bounds = buildPinnedEventIdBounds(this.chainId, input.snapshotBlock);
    const query = `
      query PinnedEventPage(
        $after: String!
        $through: String!
        $limit: Int!
        ${input.variableDefinitions ?? ""}
      ) {
        rows: ${input.root}(
          where: {
            id: { _gt: $after, _lte: $through }
            ${input.additionalWhere ?? ""}
          }
          order_by: { id: asc }
          limit: $limit
        ) {
          ${input.selection}
        }
      }
    `;
    const rows: T[] = [];
    let after = bounds.after;
    for (;;) {
      const data = await this.query<{ rows: T[] }>(query, {
        after,
        through: bounds.through,
        limit: PAGE_SIZE,
        ...input.variables,
      });
      const page = data.rows;
      if (!Array.isArray(page)) {
        throw new Error(`Indexer response omitted ${input.root}`);
      }
      let previousId = after;
      for (const row of page) {
        if (typeof row.id !== "string" || row.id <= previousId) {
          throw new Error(`Indexer returned non-ascending ${input.root} event ids`);
        }
        previousId = row.id;
      }
      rows.push(...page);
      if (rows.length > input.maximumRows) {
        throw new Error(`${input.root} exceeds its block-snapshot safety limit`);
      }
      if (page.length < PAGE_SIZE) break;
      const next = page.at(-1)?.id;
      if (!next || next <= after) {
        throw new Error(`Indexer pagination did not advance for ${input.root}`);
      }
      after = next;
    }
    return rows;
  }

  private async getDepositMakerRows(): Promise<RawDepositMaker[]> {
    const query = `
      query DepositMakerPage($chainId: Int!, $after: String!, $limit: Int!) {
        Deposit(
          where: {
            chainId: { _eq: $chainId }
            id: { _gt: $after }
          }
          order_by: { id: asc }
          limit: $limit
        ) {
          id
          chainId
          escrowAddress
          depositId
          depositor
        }
      }
    `;
    const rows: RawDepositMaker[] = [];
    let after = "";
    for (;;) {
      const data = await this.query<{ Deposit: RawDepositMaker[] }>(query, {
        chainId: this.chainId,
        after,
        limit: PAGE_SIZE,
      });
      const page = data.Deposit;
      if (!Array.isArray(page)) throw new Error("Indexer response omitted Deposit");
      let previousId = after;
      for (const row of page) {
        if (typeof row.id !== "string" || row.id <= previousId) {
          throw new Error("Indexer returned duplicate or non-ascending Deposit ids");
        }
        previousId = row.id;
      }
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
      const next = page.at(-1)?.id;
      if (!next || next <= after) {
        throw new Error("Indexer pagination did not advance for Deposit");
      }
      after = next;
    }
    return rows;
  }

  public async getBlockPinnedMerchantSnapshot(input: {
    snapshotBlock: bigint;
    v2Environment: V2HistoryEnvironment;
  }): Promise<BlockPinnedMerchantSnapshot> {
    const [deposits, v2Signals, v2Fulfillments, unifiedSignals, unifiedFulfillments] =
      await Promise.all([
        this.getDepositMakerRows(),
        this.getPinnedEventRows<RawV2MerchantIntentSignaled>({
          root: "Escrow_V2_IntentSignaled",
          selection: "id intentHash depositId verifier amount",
          snapshotBlock: input.snapshotBlock,
          maximumRows: MAX_V2_SIGNAL_ROWS,
        }),
        this.getPinnedEventRows<RawV2MerchantIntentFulfilled>({
          root: "Escrow_V2_IntentFulfilled",
          selection: "id intentHash depositId verifier amount",
          snapshotBlock: input.snapshotBlock,
          maximumRows: MAX_V2_FULFILLMENT_ROWS,
        }),
        this.getPinnedEventRows<RawUnifiedMerchantIntentSignaled>({
          root: "Orchestrator_V21_IntentSignaled",
          selection: "id intentHash escrow depositId paymentMethod",
          snapshotBlock: input.snapshotBlock,
          maximumRows: MAX_UNIFIED_SIGNAL_ROWS,
        }),
        this.getPinnedEventRows<RawUnifiedMerchantIntentFulfilled>({
          root: "Orchestrator_V21_IntentFulfilled",
          selection: "id intentHash amount isManualRelease",
          snapshotBlock: input.snapshotBlock,
          maximumRows: MAX_UNIFIED_FULFILLMENT_ROWS,
        }),
      ]);
    const makerPlatformStats = reconstructMerchantPlatformRows({
      chainId: this.chainId,
      snapshotBlock: input.snapshotBlock,
      v2Environment: input.v2Environment,
      deposits,
      v2Signals,
      v2Fulfillments,
      unifiedSignals,
      unifiedFulfillments,
    });
    const referencedDepositIds = new Set<string>();
    for (const row of v2Signals) {
      referencedDepositIds.add(
        `${V2_HISTORY_ESCROW_BY_ENVIRONMENT[input.v2Environment]}_${row.depositId}`,
      );
    }
    for (const row of unifiedSignals) {
      referencedDepositIds.add(`${row.escrow.toLowerCase()}_${row.depositId}`);
    }
    const referencedDeposits = deposits.filter((row) =>
      referencedDepositIds.has(row.id.toLowerCase()),
    );
    const evidenceDigest = `0x${createHash("sha256")
      .update(
        JSON.stringify({
          snapshotBlock: input.snapshotBlock.toString(),
          referencedDeposits,
          v2Signals,
          v2Fulfillments,
          unifiedSignals,
          unifiedFulfillments,
        }),
      )
      .digest("hex")}` as Hex;
    return {
      makerPlatformStats,
      evidenceDigest,
      snapshotBlock: input.snapshotBlock,
    };
  }

  public async getBlockPinnedMembershipSnapshot(input: {
    registryAddress: Address;
    groupIds: GroupId[];
    deploymentBlock: bigint;
    snapshotBlock: bigint;
  }): Promise<BlockPinnedMembershipSnapshot> {
    const uniqueGroupIds = [...new Set(input.groupIds)];
    if (uniqueGroupIds.length === 0 || uniqueGroupIds.length !== input.groupIds.length) {
      throw new Error("Address group ids must be non-empty and unique");
    }
    if (input.deploymentBlock > input.snapshotBlock) {
      throw new Error("Registry deployment block is greater than the requested snapshot");
    }
    const [creations, additions, removals, groupBindings] = await Promise.all([
      this.getPinnedEventRows<RawGroupCreatedEvent>({
        root: "AddressGroupRegistry_GroupCreated",
        selection: "id groupId",
        snapshotBlock: input.snapshotBlock,
        maximumRows: uniqueGroupIds.length,
        additionalWhere: "groupId: { _in: $groupIds }",
        variableDefinitions: "$groupIds: [String!]!",
        variables: { groupIds: uniqueGroupIds },
      }),
      this.getPinnedEventRows<RawMemberEvent>({
        root: "AddressGroupRegistry_MemberAdded",
        selection: "id groupId member",
        snapshotBlock: input.snapshotBlock,
        maximumRows: MAX_GROUP_EVENT_ROWS,
        additionalWhere: "groupId: { _in: $groupIds }",
        variableDefinitions: "$groupIds: [String!]!",
        variables: { groupIds: uniqueGroupIds },
      }),
      this.getPinnedEventRows<RawMemberEvent>({
        root: "AddressGroupRegistry_MemberRemoved",
        selection: "id groupId member",
        snapshotBlock: input.snapshotBlock,
        maximumRows: MAX_GROUP_EVENT_ROWS,
        additionalWhere: "groupId: { _in: $groupIds }",
        variableDefinitions: "$groupIds: [String!]!",
        variables: { groupIds: uniqueGroupIds },
      }),
      this.getGroupBindingRows(uniqueGroupIds),
    ]);
    this.assertGroupRegistryBinding({
      registryAddress: input.registryAddress,
      groupIds: uniqueGroupIds,
      rows: groupBindings,
    });
    const evidenceDigest = `0x${createHash("sha256")
      .update(
        JSON.stringify({
          snapshotBlock: input.snapshotBlock.toString(),
          creations,
          additions,
          removals,
          groupBindings,
        }),
      )
      .digest("hex")}` as Hex;
    return {
      evidenceDigest,
      membership: {
        membersByGroupId: reconstructMembership({
          chainId: this.chainId,
          snapshotBlock: input.snapshotBlock,
          groupIds: uniqueGroupIds,
          creations,
          additions,
          removals,
        }),
        snapshotBlock: input.snapshotBlock,
        indexedThroughBlock: input.snapshotBlock,
      },
    };
  }

  /**
   * Reconstructs policy volume and group membership only from immutable event
   * rows whose event ids are bounded by one explicit finalized Base block.
   * Multiple GraphQL requests are safe because later indexing cannot mutate
   * rows at or below the chosen block.
   */
  public async getBlockPinnedReconciliationSnapshot(input: {
    registryAddress: Address;
    groupIds: GroupId[];
    deploymentBlock: bigint;
    paymentMethodHashes: ReadonlySet<Hex>;
    snapshotBlock: bigint;
    v2Environment: V2HistoryEnvironment;
  }): Promise<BlockPinnedReconciliationSnapshot> {
    this.validatePaymentMethodHashes(input.paymentMethodHashes);
    const uniqueGroupIds = [...new Set(input.groupIds)];
    if (uniqueGroupIds.length === 0 || uniqueGroupIds.length !== input.groupIds.length) {
      throw new Error("Address group ids must be non-empty and unique");
    }
    if (input.deploymentBlock > input.snapshotBlock) {
      throw new Error("Registry deployment block is greater than the requested snapshot");
    }

    const [
      v2Signals,
      v2Fulfillments,
      unifiedSignals,
      unifiedFulfillments,
      creations,
      additions,
      removals,
      groupBindings,
    ] = await Promise.all([
      this.getPinnedEventRows<RawV2IntentSignaled>({
        root: "Escrow_V2_IntentSignaled",
        selection: "id intentHash verifier owner",
        snapshotBlock: input.snapshotBlock,
        maximumRows: MAX_V2_SIGNAL_ROWS,
      }),
      this.getPinnedEventRows<RawV2IntentFulfilled>({
        root: "Escrow_V2_IntentFulfilled",
        selection: "id intentHash owner amount",
        snapshotBlock: input.snapshotBlock,
        maximumRows: MAX_V2_FULFILLMENT_ROWS,
      }),
      this.getPinnedEventRows<RawUnifiedIntentSignaled>({
        root: "Orchestrator_V21_IntentSignaled",
        selection: "id intentHash paymentMethod owner",
        snapshotBlock: input.snapshotBlock,
        maximumRows: MAX_UNIFIED_SIGNAL_ROWS,
      }),
      this.getPinnedEventRows<RawUnifiedIntentFulfilled>({
        root: "Orchestrator_V21_IntentFulfilled",
        selection: "id intentHash amount",
        snapshotBlock: input.snapshotBlock,
        maximumRows: MAX_UNIFIED_FULFILLMENT_ROWS,
      }),
      this.getPinnedEventRows<RawGroupCreatedEvent>({
        root: "AddressGroupRegistry_GroupCreated",
        selection: "id groupId",
        snapshotBlock: input.snapshotBlock,
        maximumRows: uniqueGroupIds.length,
        additionalWhere: "groupId: { _in: $groupIds }",
        variableDefinitions: "$groupIds: [String!]!",
        variables: { groupIds: uniqueGroupIds },
      }),
      this.getPinnedEventRows<RawMemberEvent>({
        root: "AddressGroupRegistry_MemberAdded",
        selection: "id groupId member",
        snapshotBlock: input.snapshotBlock,
        maximumRows: MAX_GROUP_EVENT_ROWS,
        additionalWhere: "groupId: { _in: $groupIds }",
        variableDefinitions: "$groupIds: [String!]!",
        variables: { groupIds: uniqueGroupIds },
      }),
      this.getPinnedEventRows<RawMemberEvent>({
        root: "AddressGroupRegistry_MemberRemoved",
        selection: "id groupId member",
        snapshotBlock: input.snapshotBlock,
        maximumRows: MAX_GROUP_EVENT_ROWS,
        additionalWhere: "groupId: { _in: $groupIds }",
        variableDefinitions: "$groupIds: [String!]!",
        variables: { groupIds: uniqueGroupIds },
      }),
      this.getGroupBindingRows(uniqueGroupIds),
    ]);
    this.assertGroupRegistryBinding({
      registryAddress: input.registryAddress,
      groupIds: uniqueGroupIds,
      rows: groupBindings,
    });

    const evidenceDigest = `0x${createHash("sha256")
      .update(
        JSON.stringify({
          snapshotBlock: input.snapshotBlock.toString(),
          v2Signals,
          v2Fulfillments,
          unifiedSignals,
          unifiedFulfillments,
          creations,
          additions,
          removals,
          groupBindings,
        }),
      )
      .digest("hex")}` as Hex;

    return {
      evidenceDigest,
      takerPlatformStats: reconstructPlatformRows({
        chainId: this.chainId,
        snapshotBlock: input.snapshotBlock,
        v2Environment: input.v2Environment,
        v2Signals,
        v2Fulfillments,
        unifiedSignals,
        unifiedFulfillments,
      }),
      membership: {
        membersByGroupId: reconstructMembership({
          chainId: this.chainId,
          snapshotBlock: input.snapshotBlock,
          groupIds: uniqueGroupIds,
          creations,
          additions,
          removals,
        }),
        snapshotBlock: input.snapshotBlock,
        indexedThroughBlock: input.snapshotBlock,
      },
    };
  }

  public async getTakerPlatformStats(
    paymentMethodHashes: ReadonlySet<Hex>,
  ): Promise<TakerPlatformStatsRow[]> {
    const configuredHashes = this.validatePaymentMethodHashes(paymentMethodHashes);

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

    return this.parseTakerPlatformStatsRows(rawRows, paymentMethodHashes);
  }

  public async getMakerPlatformStats(
    paymentMethodHashes: ReadonlySet<Hex>,
  ): Promise<MakerPlatformStatsRow[]> {
    const configuredHashes = this.validatePaymentMethodHashes(paymentMethodHashes);
    const query = `
      query MakerPlatformStatsPage(
        $chainId: Int!
        $paymentMethodHashes: [String!]!
        $after: String!
        $limit: Int!
      ) {
        MakerPlatformStats(
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
          maker
          paymentMethodHash
          totalAmountTaken
          nonManualReleaseVolume
          manualReleaseVolume
        }
      }
    `;

    const rawRows: RawMakerPlatformStats[] = [];
    let after = "";
    for (;;) {
      const data = await this.query<{ MakerPlatformStats: RawMakerPlatformStats[] }>(query, {
        chainId: this.chainId,
        paymentMethodHashes: configuredHashes,
        after,
        limit: PAGE_SIZE,
      });
      const page = data.MakerPlatformStats;
      if (!Array.isArray(page)) {
        throw new Error("Indexer response omitted MakerPlatformStats");
      }
      let previousId = after;
      for (const row of page) {
        if (typeof row.id !== "string" || row.id <= previousId) {
          throw new Error("Indexer returned duplicate or non-ascending MakerPlatformStats ids");
        }
        previousId = row.id;
      }
      rawRows.push(...page);
      if (page.length < PAGE_SIZE) break;
      const next = page.at(-1)?.id;
      if (!next || next <= after) {
        throw new Error("Indexer pagination did not advance for MakerPlatformStats");
      }
      after = next;
    }

    if (new Set(rawRows.map((row) => row.id)).size !== rawRows.length) {
      throw new Error("Indexer returned duplicate MakerPlatformStats rows");
    }
    const rows = rawRows.map((row): MakerPlatformStatsRow => {
      const maker = normalizeAddress(row.maker, "MakerPlatformStats.maker");
      const paymentMethodHash = row.paymentMethodHash?.toLowerCase() as Hex;
      if (
        row.chainId !== this.chainId ||
        !/^0x[0-9a-f]{64}$/.test(paymentMethodHash) ||
        !paymentMethodHashes.has(paymentMethodHash)
      ) {
        throw new Error("Indexer returned an unexpected MakerPlatformStats row");
      }
      const canonicalId = `${this.chainId}_${maker}_${paymentMethodHash}`;
      if (row.id.toLowerCase() !== canonicalId) {
        throw new Error("Indexer returned an invalid MakerPlatformStats id");
      }
      const amounts = [
        ["totalAmountTaken", row.totalAmountTaken],
        ["nonManualReleaseVolume", row.nonManualReleaseVolume],
        ["manualReleaseVolume", row.manualReleaseVolume],
      ] as const;
      for (const [field, value] of amounts) {
        if (typeof value !== "string" || !/^\d+$/.test(value)) {
          throw new Error(`Indexer returned invalid MakerPlatformStats.${field}`);
        }
      }
      const totalAmountTaken = BigInt(row.totalAmountTaken);
      const nonManualReleaseVolume = BigInt(row.nonManualReleaseVolume);
      const manualReleaseVolume = BigInt(row.manualReleaseVolume);
      if (totalAmountTaken !== nonManualReleaseVolume + manualReleaseVolume) {
        throw new Error("Indexer MakerPlatformStats volume split does not equal totalAmountTaken");
      }
      return {
        id: canonicalId,
        maker,
        paymentMethodHash,
        totalAmountTaken,
        nonManualReleaseVolume,
        manualReleaseVolume,
      };
    });
    if (new Set(rows.map((row) => row.id)).size !== rows.length) {
      throw new Error("Indexer returned duplicate canonical MakerPlatformStats rows");
    }
    return rows;
  }
}
