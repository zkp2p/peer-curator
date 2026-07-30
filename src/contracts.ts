import { parseAbi } from "viem";

/**
 * Minimal runtime surface copied from zkp2p/zkp2p-v2-contracts main at
 * b00c6f96816a657f20eae8d91c9ae2cec683b9d6.
 */
export const addressGroupRegistryAbi = parseAbi([
  "function createGroup(string name) returns (bytes32 groupId)",
  "function groupExists(bytes32 groupId) view returns (bool)",
  "function getGroup(bytes32 groupId) view returns (address curator, address pendingCurator, address resolver, bool isPublic, bool exists)",
  "function members(bytes32 groupId, address account) view returns (bool)",
  "function addMembers(bytes32 groupId, address[] members)",
  "function removeMembers(bytes32 groupId, address[] members)",
  "event GroupCreated(bytes32 indexed groupId, address indexed curator, string name)",
  "event MemberAdded(bytes32 indexed groupId, address indexed member)",
  "event MemberRemoved(bytes32 indexed groupId, address indexed member)",
]);

export const CONTRACTS_UPSTREAM_COMMIT = "b00c6f96816a657f20eae8d91c9ae2cec683b9d6";
