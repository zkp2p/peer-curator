import { describe, expect, it } from "vitest";
import {
  getV2ChargebackVerifierMap,
  reconstructMembership,
  reconstructPlatformRows,
} from "../src/blockPinnedSnapshot.js";
import { normalizeGroupId } from "../src/domain.js";
import { CHARGEBACKABLE_PAYMENT_METHOD_HASHES } from "../src/paymentMethods.js";

const chainId = 8453;
const snapshotBlock = 49_000_000n;
const taker = "0x1111111111111111111111111111111111111111";
const groupId = normalizeGroupId(`0x${"22".repeat(32)}`);
const intent = (suffix: string) => `0x${suffix.repeat(64)}`;
const eventId = (logIndex: number) => `8453_48999999_${logIndex}`;
const paypalV2Verifier = [...getV2ChargebackVerifierMap("prod").entries()].find(
  ([, method]) => method === "paypal",
)?.[0];
if (!paypalV2Verifier) throw new Error("Missing fixture V2 PayPal verifier");

describe("block-pinned event reconstruction", () => {
  it("aggregates V2 and unified chargeback fills by taker and platform", () => {
    const rows = reconstructPlatformRows({
      chainId,
      snapshotBlock,
      v2Environment: "prod",
      v2Signals: [
        {
          id: eventId(1),
          intentHash: intent("1"),
          verifier: paypalV2Verifier,
          owner: taker,
        },
      ],
      v2Fulfillments: [
        {
          id: eventId(2),
          intentHash: intent("1"),
          owner: taker,
          amount: "300000000",
        },
      ],
      unifiedSignals: [
        {
          id: eventId(3),
          intentHash: intent("2"),
          paymentMethod: CHARGEBACKABLE_PAYMENT_METHOD_HASHES.paypal,
          owner: taker,
        },
        {
          id: eventId(4),
          intentHash: intent("3"),
          paymentMethod: CHARGEBACKABLE_PAYMENT_METHOD_HASHES.venmo,
          owner: taker,
        },
      ],
      unifiedFulfillments: [
        { id: eventId(5), intentHash: intent("2"), amount: "200000000" },
        { id: eventId(6), intentHash: intent("3"), amount: "100000000" },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(
      rows.find((row) => row.paymentMethodHash === CHARGEBACKABLE_PAYMENT_METHOD_HASHES.paypal)
        ?.totalAmountTaken,
    ).toBe(500000000n);
    expect(
      rows.find((row) => row.paymentMethodHash === CHARGEBACKABLE_PAYMENT_METHOD_HASHES.venmo)
        ?.totalAmountTaken,
    ).toBe(100000000n);
  });

  it("ignores pending chargeback signals and unrelated fulfillments", () => {
    const rows = reconstructPlatformRows({
      chainId,
      snapshotBlock,
      v2Environment: "prod",
      v2Signals: [],
      v2Fulfillments: [],
      unifiedSignals: [
        {
          id: eventId(1),
          intentHash: intent("1"),
          paymentMethod: CHARGEBACKABLE_PAYMENT_METHOD_HASHES.cashapp,
          owner: taker,
        },
      ],
      unifiedFulfillments: [{ id: eventId(2), intentHash: intent("2"), amount: "500000000" }],
    });
    expect(rows).toEqual([]);
  });

  it("fails closed on duplicate fulfillment events", () => {
    expect(() =>
      reconstructPlatformRows({
        chainId,
        snapshotBlock,
        v2Environment: "prod",
        v2Signals: [],
        v2Fulfillments: [],
        unifiedSignals: [
          {
            id: eventId(1),
            intentHash: intent("1"),
            paymentMethod: CHARGEBACKABLE_PAYMENT_METHOD_HASHES.cashapp,
            owner: taker,
          },
        ],
        unifiedFulfillments: [
          { id: eventId(2), intentHash: intent("1"), amount: "100000000" },
          { id: eventId(3), intentHash: intent("1"), amount: "100000000" },
        ],
      }),
    ).toThrow("duplicate chargebackable fulfillment");
  });

  it("replays adds and removals in block/log order", () => {
    const first = "0x3333333333333333333333333333333333333333";
    const second = "0x4444444444444444444444444444444444444444";
    const members = reconstructMembership({
      chainId,
      snapshotBlock,
      groupIds: [groupId],
      creations: [{ id: eventId(1), groupId }],
      additions: [
        { id: eventId(2), groupId, member: first },
        { id: eventId(4), groupId, member: second },
      ],
      removals: [{ id: eventId(3), groupId, member: first }],
    });
    expect(members.get(groupId)).toEqual(new Set([second]));
  });

  it("fails closed on an impossible membership history", () => {
    expect(() =>
      reconstructMembership({
        chainId,
        snapshotBlock,
        groupIds: [groupId],
        creations: [{ id: eventId(1), groupId }],
        additions: [],
        removals: [
          {
            id: eventId(2),
            groupId,
            member: "0x5555555555555555555555555555555555555555",
          },
        ],
      }),
    ).toThrow("removal for an inactive member");
  });

  it("fails closed on membership events before group creation", () => {
    expect(() =>
      reconstructMembership({
        chainId,
        snapshotBlock,
        groupIds: [groupId],
        creations: [{ id: eventId(2), groupId }],
        additions: [
          {
            id: eventId(1),
            groupId,
            member: "0x5555555555555555555555555555555555555555",
          },
        ],
        removals: [],
      }),
    ).toThrow("before group creation");
  });
});
