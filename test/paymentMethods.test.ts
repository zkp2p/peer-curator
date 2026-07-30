import { describe, expect, it } from "vitest";
import {
  CHARGEBACKABLE_PAYMENT_METHOD_HASHES,
  CHARGEBACKABLE_PAYMENT_METHOD_NAMES,
  resolveChargebackablePaymentMethodHashes,
} from "../src/paymentMethods.js";

describe("chargebackable payment-method mappings", () => {
  it("resolves exactly PayPal, Venmo, and Cash App from contracts-v2", () => {
    expect(Object.keys(CHARGEBACKABLE_PAYMENT_METHOD_HASHES).sort()).toEqual(
      [...CHARGEBACKABLE_PAYMENT_METHOD_NAMES].sort(),
    );
    expect(new Set(Object.values(CHARGEBACKABLE_PAYMENT_METHOD_HASHES)).size).toBe(3);
  });

  it("fails closed when a required canonical mapping is missing", () => {
    expect(() =>
      resolveChargebackablePaymentMethodHashes({
        nameToHash: {},
        hashToName: {},
      }),
    ).toThrow("missing a valid paypal hash");
  });

  it("fails closed when a configured mapping is unknown or inconsistent", () => {
    expect(() =>
      resolveChargebackablePaymentMethodHashes({
        nameToHash: {
          paypal: `0x${"11".repeat(32)}`,
          venmo: CHARGEBACKABLE_PAYMENT_METHOD_HASHES.venmo,
          cashapp: CHARGEBACKABLE_PAYMENT_METHOD_HASHES.cashapp,
        },
        hashToName: {
          [CHARGEBACKABLE_PAYMENT_METHOD_HASHES.venmo]: "venmo",
          [CHARGEBACKABLE_PAYMENT_METHOD_HASHES.cashapp]: "cashapp",
        },
      }),
    ).toThrow("noncanonical paypal hash");
  });
});
