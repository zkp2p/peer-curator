import { getAbiItem } from "viem";
import { describe, expect, it } from "vitest";
import { addressGroupRegistryAbi } from "../src/contracts.js";

describe("AddressGroupRegistry ABI", () => {
  it("contains every read, write, and event surface used by the reconciler", () => {
    for (const name of [
      "getGroup",
      "members",
      "addMembers",
      "removeMembers",
      "MemberAdded",
      "MemberRemoved",
    ] as const) {
      expect(getAbiItem({ abi: addressGroupRegistryAbi, name })).toBeDefined();
    }
  });
});
