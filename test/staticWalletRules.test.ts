import { describe, expect, it } from "vitest";
import { normalizeAddress } from "../src/domain.js";
import {
  BLOCKED_WALLET_HASHES,
  HISTORICAL_TOP_TIER_OVERRIDE_HASHES,
  hashWallet,
  isBlockedWallet,
  isHistoricalTopTierOverride,
} from "../src/staticWalletRules.js";

describe("static wallet rules", () => {
  it("contains the audited snapshots without duplicate hashes", () => {
    expect(BLOCKED_WALLET_HASHES).toHaveLength(25);
    expect(new Set(BLOCKED_WALLET_HASHES).size).toBe(25);
    expect(HISTORICAL_TOP_TIER_OVERRIDE_HASHES).toHaveLength(3);
    expect(new Set(HISTORICAL_TOP_TIER_OVERRIDE_HASHES).size).toBe(3);
  });

  it("hashes normalized address bytes deterministically", () => {
    const address = normalizeAddress("0x1111111111111111111111111111111111111111");
    expect(hashWallet(address)).toBe(
      "0xe2c07404b8c1df4c46226425cac68c28d27a766bbddce62309f36724839b22c0",
    );
    expect(isBlockedWallet(address)).toBe(false);
    expect(isHistoricalTopTierOverride(address)).toBe(false);
  });
});
