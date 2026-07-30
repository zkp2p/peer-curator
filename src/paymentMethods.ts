import lookups from "@zkp2p/contracts-v2/paymentMethods/lookups.json" with { type: "json" };
import type { Hex } from "viem";
import { keccak256, stringToBytes } from "viem";

export const CHARGEBACKABLE_PAYMENT_METHOD_NAMES = ["paypal", "venmo", "cashapp"] as const;

type ChargebackablePaymentMethodName = (typeof CHARGEBACKABLE_PAYMENT_METHOD_NAMES)[number];

interface PaymentMethodLookups {
  nameToHash?: Record<string, unknown>;
  hashToName?: Record<string, unknown>;
}

function normalizePaymentMethodHash(value: unknown, name: ChargebackablePaymentMethodName): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Contracts payment-method lookup is missing a valid ${name} hash`);
  }
  return value.toLowerCase() as Hex;
}

export function resolveChargebackablePaymentMethodHashes(
  source: PaymentMethodLookups = lookups,
): Readonly<Record<ChargebackablePaymentMethodName, Hex>> {
  const entries = CHARGEBACKABLE_PAYMENT_METHOD_NAMES.map((name) => {
    const hash = normalizePaymentMethodHash(source.nameToHash?.[name], name);
    const canonicalHash = keccak256(stringToBytes(name));
    if (hash !== canonicalHash) {
      throw new Error(`Contracts payment-method lookup contains a noncanonical ${name} hash`);
    }
    if (source.hashToName?.[hash] !== name) {
      throw new Error(`Contracts payment-method reverse lookup is inconsistent for ${name}`);
    }
    return [name, hash] as const;
  });

  const hashes = entries.map(([, hash]) => hash);
  if (new Set(hashes).size !== hashes.length) {
    throw new Error("Contracts payment-method lookup contains duplicate chargebackable hashes");
  }
  return Object.freeze(Object.fromEntries(entries)) as Readonly<
    Record<ChargebackablePaymentMethodName, Hex>
  >;
}

export const CHARGEBACKABLE_PAYMENT_METHOD_HASHES = resolveChargebackablePaymentMethodHashes();
export const CHARGEBACKABLE_PAYMENT_METHOD_HASH_SET = new Set<Hex>(
  Object.values(CHARGEBACKABLE_PAYMENT_METHOD_HASHES),
);
