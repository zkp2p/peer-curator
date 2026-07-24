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
