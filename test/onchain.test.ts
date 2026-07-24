import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { normalizeAddress } from "../src/domain.js";
import { type MembershipEvent, replayMembershipEvents } from "../src/onchain.js";

const member = (digit: string): Address => normalizeAddress(`0x${digit.repeat(40)}`);

describe("replayMembershipEvents", () => {
  it("replays add/remove events in block and log order", () => {
    const a = member("a");
    const b = member("b");
    const events: MembershipEvent[] = [
      { groupId: 1n, member: a, present: false, blockNumber: 12n, logIndex: 1 },
      { groupId: 1n, member: b, present: true, blockNumber: 11n, logIndex: 2 },
      { groupId: 1n, member: a, present: true, blockNumber: 10n, logIndex: 3 },
      { groupId: 1n, member: a, present: true, blockNumber: 12n, logIndex: 2 },
      { groupId: 99n, member: a, present: true, blockNumber: 9n, logIndex: 0 },
    ];

    expect(replayMembershipEvents(events, [1n]).get(1n)).toEqual(new Set([a, b]));
    expect(replayMembershipEvents([], [2n]).get(2n)).toEqual(new Set());
  });
});
