import { getAbiItem } from "viem";
import { describe, expect, it } from "vitest";
import { addressGroupRegistryAbi } from "../src/contracts.js";

describe("AddressGroupRegistry ABI", () => {
  it("contains every read, write, and event surface used by the reconciler", () => {
    for (const name of [
      "createGroup",
      "getGroup",
      "members",
      "addMembers",
      "removeMembers",
      "MemberAdded",
      "MemberRemoved",
    ] as const) {
      expect(getAbiItem({ abi: addressGroupRegistryAbi, name })).toBeDefined();
    }
    const getGroup = getAbiItem({ abi: addressGroupRegistryAbi, name: "getGroup" });
    expect(getGroup.type).toBe("function");
    if (getGroup.type !== "function") throw new Error("getGroup ABI item is not a function");
    expect(getGroup.inputs[0]?.type).toBe("bytes32");
    expect(getGroup.outputs).toHaveLength(5);
  });
});
