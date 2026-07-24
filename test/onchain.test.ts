import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { type GroupsConfig, normalizeAddress } from "../src/domain.js";
import { loadRegistryState, type MembershipEvent, replayMembershipEvents } from "../src/onchain.js";

const member = (digit: string): Address => normalizeAddress(`0x${digit.repeat(40)}`);

describe("replayMembershipEvents", () => {
  it("replays add/remove events in block and log order", () => {
    const a = member("a");
    const b = member("b");
    const events: MembershipEvent[] = [
      { groupId: 1n, member: a, present: false, blockNumber: 12n, logIndex: 1n },
      { groupId: 1n, member: b, present: true, blockNumber: 11n, logIndex: 2n },
      { groupId: 1n, member: a, present: true, blockNumber: 10n, logIndex: 3n },
      { groupId: 1n, member: a, present: true, blockNumber: 12n, logIndex: 2n },
    ];

    expect(replayMembershipEvents(events, [1n]).get(1n)).toEqual(new Set([a, b]));
    expect(replayMembershipEvents([], [2n]).get(2n)).toEqual(new Set());
  });

  it("fails closed for events from an unexpected group", () => {
    expect(() =>
      replayMembershipEvents(
        [
          {
            groupId: 99n,
            member: member("a"),
            present: true,
            blockNumber: 9n,
            logIndex: 0n,
          },
        ],
        [1n],
      ),
    ).toThrow("unexpected group");
  });

  it("loads governance at the pinned block without scanning RPC logs", async () => {
    const registryAddress = member("9");
    const owner = member("8");
    const client = {
      getBytecode: vi.fn().mockResolvedValue("0x1234"),
      readContract: vi.fn().mockResolvedValue([owner, member("0"), member("0"), true] as const),
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
          groupId: 1n,
          minimumMembers: 0,
        },
      ],
    };

    const state = await loadRegistryState(client as never, config, {
      snapshotBlock: 120n,
      indexedThroughBlock: 125n,
      events: [
        {
          id: "event-1",
          chainId: 8453,
          registryAddress,
          groupId: 1n,
          member: member("a"),
          present: true,
          blockNumber: 110n,
          logIndex: 1n,
        },
      ],
    });

    expect(state.membersByGroupId.get(1n)).toEqual(new Set([member("a")]));
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
