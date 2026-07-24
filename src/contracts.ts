import { parseAbi, parseAbiItem } from "viem";

/**
 * Minimal runtime surface copied from zkp2p/zkp2p-v2-contracts main at
 * 764a125d7a859184127a36c44de3beaf5611c0d5.
 */
export const addressGroupRegistryAbi = parseAbi([
  "function groupExists(uint256 groupId) view returns (bool)",
  "function getGroup(uint256 groupId) view returns (address owner, address pendingOwner, address resolver, bool exists)",
  "function members(uint256 groupId, address account) view returns (bool)",
  "function addMembers(uint256 groupId, address[] members)",
  "function removeMembers(uint256 groupId, address[] members)",
  "event GroupCreated(uint256 indexed groupId, address indexed owner, string name)",
  "event MemberAdded(uint256 indexed groupId, address indexed member)",
  "event MemberRemoved(uint256 indexed groupId, address indexed member)",
]);

export const memberAddedEvent = parseAbiItem(
  "event MemberAdded(uint256 indexed groupId, address indexed member)",
);
export const memberRemovedEvent = parseAbiItem(
  "event MemberRemoved(uint256 indexed groupId, address indexed member)",
);
export const groupCreatedEvent = parseAbiItem(
  "event GroupCreated(uint256 indexed groupId, address indexed owner, string name)",
);

export const CONTRACTS_UPSTREAM_COMMIT = "764a125d7a859184127a36c44de3beaf5611c0d5";
