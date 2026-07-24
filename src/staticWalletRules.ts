import { type Address, type Hex, keccak256 } from "viem";

/**
 * Snapshot of Curator production BlockedWallet entries on 2026-07-24.
 *
 * We commit keccak256(address_bytes), not raw wallet identifiers. This keeps
 * verification deterministic and local: hash the normalized 20-byte address
 * and compare it with this set.
 */
export const BLOCKED_WALLET_HASHES = [
  "0x044bdb0433bb7d2adbc5ed72d574d6e3458f8ee1fd5cc697803c662c4d209b4d",
  "0x048f16331f4817fb96179d9c886b2ba8bce02d297d6b191127a47f677597e54f",
  "0x059e4184ece70a9bc5127a4282eb24638ff058968c03d44c92eb3d38db3922af",
  "0x094f3e414d2dbb10e376eb7124a2606f494bce353c7ada96111648ab616482c0",
  "0x139fee98b40ae0deca8a76b4588596975d376f79b67415b674507df5125a954d",
  "0x14da3ce3d1442d9118d2a9e431e3faafdef2ac1951d5d57b38a4f6efb869409c",
  "0x15b9299bd692c268220212401db05f876e7a0f30cddf13b5eebfae2099cdac54",
  "0x181fa3c3be911bf48fbf96016513db6c59183540928eac1a7ff25953c47ff414",
  "0x252e714a57e02efaeb15e534c2e172137de273ed2c876c72e2692753b7c0ea93",
  "0x4ad8ec310bcc895dcb2597ad3342f4f0cb54e016047953b351adafc39549e6af",
  "0x587f6968956b76cc1dec97576bdc9098fd7c70cd56221cd407ae71066253f85b",
  "0x6002889aba099ae2fd5da1ed7d6e4f081a49b87926b3c413e3ff6cd00bc40bf1",
  "0x65631e8f99df32f482895124d1b4e32c9753573776d2f7e4da68c875c2c80b83",
  "0x65aace1f09beee2119b088c4235d33f2524e23f611f82baf68b75fa28bc16688",
  "0x7a4822cea8074c190036cd7fc76dd3bbd896e7a9a9da51ae35f9bf149133796c",
  "0x7d2c871b1b75ec6458c8e4ce106f1101306becc6c2b96c595707b5b16bce99bb",
  "0x843dc7610ea1b1f221537bce10e8507c23f57150b85cad188073824bcddccd11",
  "0xa1b22133845f158dbf2f4b070307c62e928c0a4b5598953cbc3934b51de238f1",
  "0xa682d15617f7635d75bd0074227db698078d56ebfe7007db2eb695483a7ecddb",
  "0xb1720c3d300601a68c10e7a52573f4c6d158ed0ebb8d741b1fd3aab471a38249",
  "0xbacbf7635a3bfdd9ef94a5a14e0904ec1e0fb773bba2a01921974f5a73ee415f",
  "0xc0645e85558253218dfbe72ed7ffbfd52df7f95d5c2563618d129f6c73c5036f",
  "0xe001da9f2c67f05e9d51af2c43850b752e3ff39b1e80f863f8d10a07c4a302f9",
  "0xf0a74fdb0492edc72b1744191fe10be903d08d312808213a78260418b88c79c5",
  "0xfa87779521f7a493eb272dc3c54ea817ed1787d7386b5452f444300be2c4e476",
] as const satisfies readonly Hex[];

/**
 * The three legacy Peer President overrides, encoded the same way. All three
 * currently have TakerStats rows and also qualify naturally for the top band,
 * which is folded into the public Pro tier.
 */
export const HISTORICAL_TOP_TIER_OVERRIDE_HASHES = [
  "0x5115328c977aca61cd9db195fe8b2c6ccf06172f43c394718be3bbf8a1b0c2f8",
  "0xb7f9b6d0b54f61e9294bfdfff140ed0a7cf7040de56fa3e22c6970f7a7710a7e",
  "0xdc338be77d50c3336de17671893cc76205b0959edb6c0a3d58b8ebedcc36c4a8",
] as const satisfies readonly Hex[];

const blockedWalletHashSet = new Set<Hex>(BLOCKED_WALLET_HASHES);
const historicalTopTierOverrideHashSet = new Set<Hex>(HISTORICAL_TOP_TIER_OVERRIDE_HASHES);

export function hashWallet(address: Address): Hex {
  return keccak256(address);
}

export function isBlockedWallet(address: Address): boolean {
  return blockedWalletHashSet.has(hashWallet(address));
}

export function isHistoricalTopTierOverride(address: Address): boolean {
  return historicalTopTierOverrideHashSet.has(hashWallet(address));
}
