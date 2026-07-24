import { describe, expect, it } from "vitest";
import { assertPinnedIndexerSnapshot } from "../src/runner.js";

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
