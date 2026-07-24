import { describe, expect, it } from "vitest";
import {
  assertPinnedIndexerSnapshot,
  IndexerSnapshotAdvancedError,
  runWithSnapshotRetries,
} from "../src/runner.js";

describe("assertPinnedIndexerSnapshot", () => {
  it("accepts a stable, confirmed indexer watermark behind the RPC head", () => {
    expect(() =>
      assertPinnedIndexerSnapshot({
        snapshotBlock: 150n,
        finalIndexedBlock: 150n,
        rpcLatestBlock: 200n,
        confirmationBlocks: 20n,
      }),
    ).not.toThrow();
  });

  it("rejects an indexer watermark that changed while aggregate and membership rows were read", () => {
    expect(() =>
      assertPinnedIndexerSnapshot({
        snapshotBlock: 150n,
        finalIndexedBlock: 151n,
        rpcLatestBlock: 200n,
        confirmationBlocks: 20n,
      }),
    ).toThrow("Indexer advanced");
  });

  it("rejects a watermark that has not reached the configured confirmation depth", () => {
    expect(() =>
      assertPinnedIndexerSnapshot({
        snapshotBlock: 190n,
        finalIndexedBlock: 190n,
        rpcLatestBlock: 200n,
        confirmationBlocks: 20n,
      }),
    ).toThrow("not sufficiently confirmed");
  });
});

describe("runWithSnapshotRetries", () => {
  it("retries only the read-only snapshot race and then succeeds", async () => {
    let attempts = 0;
    const operation = async () => {
      attempts += 1;
      if (attempts < 3) throw new IndexerSnapshotAdvancedError();
    };
    const logger = {
      warn: () => undefined,
    };

    await runWithSnapshotRetries(
      {
        snapshotMaxAttempts: 3,
        snapshotRetryDelayMs: 0,
      } as never,
      logger as never,
      undefined,
      operation as never,
    );

    expect(attempts).toBe(3);
  });

  it("does not retry unrelated failures", async () => {
    let attempts = 0;
    const operation = async () => {
      attempts += 1;
      throw new Error("transaction failed");
    };

    await expect(
      runWithSnapshotRetries(
        {
          snapshotMaxAttempts: 10,
          snapshotRetryDelayMs: 0,
        } as never,
        { warn: () => undefined } as never,
        undefined,
        operation as never,
      ),
    ).rejects.toThrow("transaction failed");
    expect(attempts).toBe(1);
  });
});
