import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

interface SurfaceCheck {
  producer: string;
  ref: string;
  surface: string;
  status: "compatible" | "incompatible";
  missing: string[];
}

const workspaceCandidates = [
  ...(process.env.WORKSPACE_ROOT ? [resolve(process.env.WORKSPACE_ROOT)] : []),
  resolve(".."),
  resolve("../.."),
];
const workspace =
  workspaceCandidates.find(
    (candidate) =>
      existsSync(resolve(candidate, "zkp2p-v2-contracts")) &&
      existsSync(resolve(candidate, "zkp2p-indexer")),
  ) ?? workspaceCandidates[0];
if (!workspace) {
  throw new Error("Unable to resolve the workspace root");
}
const contractsRepo = resolve(workspace, "zkp2p-v2-contracts");
const indexerRepo = resolve(workspace, "zkp2p-indexer");

function show(repo: string, ref: string, path: string): string {
  return execFileSync("git", ["-C", repo, "show", `${ref}:${path}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function check(input: {
  producer: string;
  ref: string;
  surface: string;
  content: string;
  required: string[];
}): SurfaceCheck {
  const missing = input.required.filter((needle) => !input.content.includes(needle));
  return {
    producer: input.producer,
    ref: input.ref,
    surface: input.surface,
    status: missing.length === 0 ? "compatible" : "incompatible",
    missing,
  };
}

const contractSource = show(
  contractsRepo,
  "origin/main",
  "contracts/registries/AddressGroupRegistry.sol",
);
const productionIndexerSchema = show(indexerRepo, "origin/releases/prod", "schema.graphql");
const mainIndexerSchema = show(indexerRepo, "origin/main", "schema.graphql");
const mainIndexerConfig = show(indexerRepo, "origin/main", "config.base_prod.yaml");
const mainAddressGroupHandler = show(
  indexerRepo,
  "origin/main",
  "src/handlers/v3/address_group_registry.ts",
);

const runtimeChecks = [
  check({
    producer: "zkp2p-v2-contracts",
    ref: "origin/main",
    surface: "AddressGroupRegistry",
    content: contractSource,
    required: [
      "function addMembers",
      "function removeMembers",
      "event MemberAdded",
      "event MemberRemoved",
      "function getGroup",
    ],
  }),
  check({
    producer: "zkp2p-indexer",
    ref: "origin/releases/prod",
    surface: "tier aggregate schema",
    content: productionIndexerSchema,
    required: [
      "lockScore: BigInt!",
      "totalAmountTakenPreEarnCutover: BigInt!",
      "type MakerPeerPayStats",
      "ppTakenPostEarnCutover: BigInt!",
    ],
  }),
];

const forwardChecks = [
  check({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    surface: "tier aggregate schema",
    content: mainIndexerSchema,
    required: [
      "lockScore: BigInt!",
      "totalAmountTakenPreEarnCutover: BigInt!",
      "type MakerPeerPayStats",
      "ppTakenPostEarnCutover: BigInt!",
    ],
  }),
];

const membershipPrerequisiteChecks = [
  check({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    surface: "AddressGroupRegistry event source",
    content: mainIndexerConfig,
    required: [
      "name: AddressGroupRegistry",
      "MemberAdded(uint256 indexed groupId, address indexed member)",
      "MemberRemoved(uint256 indexed groupId, address indexed member)",
    ],
  }),
  check({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    surface: "append-only address-group membership event schema",
    content: mainIndexerSchema,
    required: [
      "type AddressGroupMembershipEvent",
      "present: Boolean!",
      "blockNumber: BigInt!",
      "logIndex: BigInt!",
    ],
  }),
  check({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    surface: "append-only address-group membership event handler",
    content: mainAddressGroupHandler,
    required: [
      "context.AddressGroupMembershipEvent.set",
      "registryAddress",
      "blockNumber",
      "logIndex",
    ],
  }),
];

process.stdout.write(
  `${JSON.stringify(
    {
      runtimeChecks,
      forwardChecks,
      membershipPrerequisiteChecks,
      note: "Tier forward drift and the membership-event prerequisite must be resolved before the corresponding producer rollout.",
    },
    null,
    2,
  )}\n`,
);

if (
  [...runtimeChecks, ...membershipPrerequisiteChecks].some((item) => item.status === "incompatible")
) {
  process.exitCode = 1;
}
