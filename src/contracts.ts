import { parseAbi } from "viem";

/**
 * Minimal runtime surface copied from zkp2p/zkp2p-v2-contracts main at
 * ce038e6c23d7cfe8fdec52ee36330a74a8478d1b.
 */
export const addressGroupRegistryAbi = parseAbi([
  "function groupExists(bytes32 groupId) view returns (bool)",
  "function getGroup(bytes32 groupId) view returns (address curator, address pendingCurator, address resolver, bool isPublic, bool exists)",
  "function members(bytes32 groupId, address account) view returns (bool)",
  "function addMembers(bytes32 groupId, address[] members)",
  "function removeMembers(bytes32 groupId, address[] members)",
  "event GroupCreated(bytes32 indexed groupId, address indexed curator, string name)",
  "event MemberAdded(bytes32 indexed groupId, address indexed member)",
  "event MemberRemoved(bytes32 indexed groupId, address indexed member)",
]);

export const CONTRACTS_UPSTREAM_COMMIT = "ce038e6c23d7cfe8fdec52ee36330a74a8478d1b";
