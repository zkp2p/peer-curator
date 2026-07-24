import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { type GroupsConfig, normalizeAddress, normalizeGroupId } from "../src/domain.js";
import { loadRegistryState } from "../src/onchain.js";

const member = (digit: string): Address => normalizeAddress(`0x${digit.repeat(40)}`);
const groupId = normalizeGroupId(`0x${"11".repeat(32)}`);

describe("loadRegistryState", () => {
  it("loads governance at the pinned block without scanning RPC logs", async () => {
    const registryAddress = member("9");
    const curator = member("8");
    const client = {
      getBytecode: vi.fn().mockResolvedValue("0x1234"),
      readContract: vi
        .fn()
        .mockResolvedValue([curator, member("0"), member("0"), false, true] as const),
      getLogs: vi.fn().mockRejectedValue(new Error("RPC logs must not be read")),
    };
    const config: GroupsConfig = {
      chainId: 8453,
      registryAddress,
      registryDeploymentBlock: 100n,
      groups: [
        {
          scope: "historical-taker",
          tier: "PEER",
          groupId,
          minimumMembers: 0,
        },
      ],
    };

    const state = await loadRegistryState(client as never, config, {
      snapshotBlock: 120n,
      indexedThroughBlock: 120n,
      membersByGroupId: new Map([[groupId, new Set([member("a")])]]),
    });

    expect(state.membersByGroupId.get(groupId)).toEqual(new Set([member("a")]));
    expect(client.getLogs).not.toHaveBeenCalled();
    expect(client.getBytecode).toHaveBeenCalledWith({
      address: registryAddress,
      blockNumber: 120n,
    });
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "getGroup", blockNumber: 120n }),
    );
  });
});
