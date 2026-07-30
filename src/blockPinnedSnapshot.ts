import type { Address, Hex } from "viem";
import { type GroupId, normalizeAddress, normalizeGroupId } from "./domain.js";
import { CHARGEBACKABLE_PAYMENT_METHOD_HASHES } from "./paymentMethods.js";

export interface RawV2IntentSignaled {
  id: string;
  intentHash: string;
  verifier: string;
  owner: string;
}

export interface RawV2IntentFulfilled {
  id: string;
  intentHash: string;
  owner: string;
  amount: string;
}

export interface RawUnifiedIntentSignaled {
  id: string;
  intentHash: string;
  paymentMethod: string;
  owner: string;
}

export interface RawUnifiedIntentFulfilled {
  id: string;
  intentHash: string;
  amount: string;
}

export interface RawGroupCreatedEvent {
  id: string;
  groupId: string;
}

export interface RawMemberEvent {
  id: string;
  groupId: string;
  member: string;
}

export interface EventPosition {
  blockNumber: bigint;
  logIndex: bigint;
}

export interface ReconstructedPlatformRow {
  id: string;
  taker: Address;
  paymentMethodHash: Hex;
  totalAmountTaken: bigint;
}

const BASE_EVENT_ID_MIN_BLOCK = 10_000_000n;
const BASE_EVENT_ID_MAX_BLOCK = 99_999_999n;

/*
 * Legacy V2 emitted verifier addresses rather than payment-method hashes.
 * This closed historical mapping is sourced from zkp2p-indexer
 * src/utils/paymentMethods.ts. Values map to method names; canonical hashes
 * continue to come from @zkp2p/contracts-v2.
 */
export type V2HistoryEnvironment = "staging" | "prod";

export const V2_CHARGEBACK_VERIFIER_METHOD_ENTRIES = Object.freeze([
  ["0xce6454f272127ba69e8c8128b92f2388ca343257", "venmo", "staging"],
  ["0xddb9d452180398f456fe89a43df9c65b19756cea", "cashapp", "staging"],
  ["0xb07764999679a9136d6853a5d4c70449afbfc2f8", "paypal", "staging"],
  ["0x9a733b55a875d0db4915c6b36350b24f8ab99df5", "venmo", "prod"],
  ["0x76d33a33068d86016b806df02376ddbb23dd3703", "cashapp", "prod"],
  ["0x03d17e9371c858072e171276979f6b44571c5dea", "paypal", "prod"],
] as const);

export function getV2ChargebackVerifierMap(
  environment: V2HistoryEnvironment,
): ReadonlyMap<string, keyof typeof CHARGEBACKABLE_PAYMENT_METHOD_HASHES> {
  return new Map(
    V2_CHARGEBACK_VERIFIER_METHOD_ENTRIES.filter(
      ([, , entryEnvironment]) => entryEnvironment === environment,
    ).map(([verifier, method]) => [verifier, method]),
  );
}

export function buildPinnedEventIdBounds(
  chainId: number,
  snapshotBlock: bigint,
): { after: string; through: string } {
  if (chainId !== 8453) {
    throw new Error("Block-pinned event reconstruction only supports Base");
  }
  if (snapshotBlock < BASE_EVENT_ID_MIN_BLOCK || snapshotBlock > BASE_EVENT_ID_MAX_BLOCK) {
    throw new Error("Snapshot block is outside the fail-closed Base event-id ordering window");
  }
  return {
    after: `${chainId}_${BASE_EVENT_ID_MIN_BLOCK}_-1`,
    through: `${chainId}_${snapshotBlock}_999999999`,
  };
}

export function parseEventPosition(
  id: unknown,
  chainId: number,
  snapshotBlock: bigint,
): EventPosition {
  if (typeof id !== "string") {
    throw new Error("Indexer event row has an invalid id");
  }
  const match = /^(\d+)_(\d+)_(\d+)$/.exec(id);
  if (!match) {
    throw new Error("Indexer event row has a malformed id");
  }
  const parsedChainId = Number(match[1]);
  const blockNumber = BigInt(match[2] ?? "");
  const logIndex = BigInt(match[3] ?? "");
  if (
    parsedChainId !== chainId ||
    blockNumber < BASE_EVENT_ID_MIN_BLOCK ||
    blockNumber > snapshotBlock ||
    logIndex < 0n
  ) {
    throw new Error("Indexer event row is outside the requested block snapshot");
  }
  return { blockNumber, logIndex };
}

function normalizeIntentHash(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Indexer intent event has an invalid intent hash");
  }
  return value.toLowerCase() as Hex;
}

function parseAmount(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("Indexer fulfillment event has an invalid amount");
  }
  const amount = BigInt(value);
  if (amount <= 0n) {
    throw new Error("Indexer fulfillment event has a non-positive amount");
  }
  return amount;
}

function compareEventIds(
  left: { id: string },
  right: { id: string },
  chainId: number,
  snapshotBlock: bigint,
): number {
  const a = parseEventPosition(left.id, chainId, snapshotBlock);
  const b = parseEventPosition(right.id, chainId, snapshotBlock);
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  if (a.logIndex !== b.logIndex) return a.logIndex < b.logIndex ? -1 : 1;
  return 0;
}

function ensureUniqueEventIds(
  rows: { id: string }[],
  chainId: number,
  snapshotBlock: bigint,
  label: string,
): void {
  const ids = new Set<string>();
  for (const row of rows) {
    parseEventPosition(row.id, chainId, snapshotBlock);
    if (ids.has(row.id)) {
      throw new Error(`Indexer returned duplicate ${label} event ids`);
    }
    ids.add(row.id);
  }
}

export function reconstructPlatformRows(input: {
  chainId: number;
  snapshotBlock: bigint;
  v2Environment: V2HistoryEnvironment;
  v2Signals: RawV2IntentSignaled[];
  v2Fulfillments: RawV2IntentFulfilled[];
  unifiedSignals: RawUnifiedIntentSignaled[];
  unifiedFulfillments: RawUnifiedIntentFulfilled[];
}): ReconstructedPlatformRow[] {
  const {
    chainId,
    snapshotBlock,
    v2Environment,
    v2Signals,
    v2Fulfillments,
    unifiedSignals,
    unifiedFulfillments,
  } = input;
  const v2ChargebackMethodByVerifier = getV2ChargebackVerifierMap(v2Environment);
  if (v2ChargebackMethodByVerifier.size !== 3) {
    throw new Error("Legacy V2 chargeback verifier mapping is incomplete");
  }
  ensureUniqueEventIds(v2Signals, chainId, snapshotBlock, "V2 signal");
  ensureUniqueEventIds(v2Fulfillments, chainId, snapshotBlock, "V2 fulfillment");
  ensureUniqueEventIds(unifiedSignals, chainId, snapshotBlock, "unified signal");
  ensureUniqueEventIds(unifiedFulfillments, chainId, snapshotBlock, "unified fulfillment");

  const signals = new Map<
    Hex,
    { taker: Address; paymentMethodHash: Hex; version: "v2" | "unified" }
  >();

  for (const row of v2Signals) {
    const intentHash = normalizeIntentHash(row.intentHash);
    const verifier = normalizeAddress(row.verifier, "V2 IntentSignaled.verifier");
    const methodName = v2ChargebackMethodByVerifier.get(verifier);
    if (!methodName) {
      throw new Error("Indexer returned an unexpected V2 verifier");
    }
    if (signals.has(intentHash)) {
      throw new Error("Indexer returned duplicate chargebackable intent signals");
    }
    signals.set(intentHash, {
      taker: normalizeAddress(row.owner, "V2 IntentSignaled.owner"),
      paymentMethodHash: CHARGEBACKABLE_PAYMENT_METHOD_HASHES[methodName],
      version: "v2",
    });
  }

  for (const row of unifiedSignals) {
    const intentHash = normalizeIntentHash(row.intentHash);
    const paymentMethodHash = row.paymentMethod?.toLowerCase() as Hex;
    if (!Object.values(CHARGEBACKABLE_PAYMENT_METHOD_HASHES).includes(paymentMethodHash)) {
      throw new Error("Indexer returned an unexpected unified payment method");
    }
    if (signals.has(intentHash)) {
      throw new Error("Indexer returned duplicate chargebackable intent signals");
    }
    signals.set(intentHash, {
      taker: normalizeAddress(row.owner, "unified IntentSignaled.owner"),
      paymentMethodHash,
      version: "unified",
    });
  }

  const totals = new Map<
    string,
    { taker: Address; paymentMethodHash: Hex; totalAmountTaken: bigint }
  >();
  const fulfilledIntentHashes = new Set<Hex>();

  const recordFulfillment = (inputRow: {
    intentHash: unknown;
    owner?: unknown;
    amount: unknown;
    version: "v2" | "unified";
  }): void => {
    const intentHash = normalizeIntentHash(inputRow.intentHash);
    const signal = signals.get(intentHash);
    if (!signal) return;
    if (signal.version !== inputRow.version) {
      throw new Error("Indexer returned a cross-version intent collision");
    }
    if (fulfilledIntentHashes.has(intentHash)) {
      throw new Error("Indexer returned duplicate chargebackable fulfillment");
    }
    fulfilledIntentHashes.add(intentHash);
    if (inputRow.owner !== undefined) {
      if (typeof inputRow.owner !== "string") {
        throw new Error("V2 fulfillment owner is invalid");
      }
      if (normalizeAddress(inputRow.owner, "V2 IntentFulfilled.owner") !== signal.taker) {
        throw new Error("V2 signal and fulfillment owners do not match");
      }
    }
    const key = `${chainId}_${signal.taker}_${signal.paymentMethodHash}`;
    const existing = totals.get(key);
    totals.set(key, {
      taker: signal.taker,
      paymentMethodHash: signal.paymentMethodHash,
      totalAmountTaken: (existing?.totalAmountTaken ?? 0n) + parseAmount(inputRow.amount),
    });
  };

  for (const row of v2Fulfillments) {
    recordFulfillment({ ...row, version: "v2" });
  }
  for (const row of unifiedFulfillments) {
    recordFulfillment({ ...row, version: "unified" });
  }

  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, row]) => ({ id, ...row }));
}

export function reconstructMembership(input: {
  chainId: number;
  snapshotBlock: bigint;
  groupIds: GroupId[];
  creations: RawGroupCreatedEvent[];
  additions: RawMemberEvent[];
  removals: RawMemberEvent[];
}): Map<GroupId, Set<Address>> {
  const uniqueGroupIds = [...new Set(input.groupIds)];
  if (uniqueGroupIds.length === 0 || uniqueGroupIds.length !== input.groupIds.length) {
    throw new Error("Configured group ids must be non-empty and unique");
  }
  ensureUniqueEventIds(input.creations, input.chainId, input.snapshotBlock, "group creation");
  ensureUniqueEventIds(input.additions, input.chainId, input.snapshotBlock, "member addition");
  ensureUniqueEventIds(input.removals, input.chainId, input.snapshotBlock, "member removal");

  const configured = new Set(uniqueGroupIds);
  const created = new Set<GroupId>();
  for (const row of input.creations) {
    const groupId = normalizeGroupId(row.groupId, "GroupCreated.groupId");
    if (!configured.has(groupId) || created.has(groupId)) {
      throw new Error("Indexer returned an unexpected or duplicate group creation");
    }
    created.add(groupId);
  }
  if (created.size !== configured.size) {
    throw new Error("Indexer has not indexed every configured group creation");
  }

  const membersByGroupId = new Map<GroupId, Set<Address>>(
    uniqueGroupIds.map((groupId) => [groupId, new Set<Address>()]),
  );
  const events = [
    ...input.additions.map((row) => ({ ...row, operation: "add" as const })),
    ...input.removals.map((row) => ({ ...row, operation: "remove" as const })),
  ].sort((left, right) => compareEventIds(left, right, input.chainId, input.snapshotBlock));

  for (const event of events) {
    const groupId = normalizeGroupId(event.groupId, "member event groupId");
    const members = membersByGroupId.get(groupId);
    if (!members) {
      throw new Error("Indexer returned a member event for an unexpected group");
    }
    const member = normalizeAddress(event.member, "member event wallet");
    if (event.operation === "add") {
      if (members.has(member)) {
        throw new Error("Indexer returned a duplicate active member addition");
      }
      members.add(member);
    } else {
      if (!members.has(member)) {
        throw new Error("Indexer returned a removal for an inactive member");
      }
      members.delete(member);
    }
  }

  return membersByGroupId;
}
