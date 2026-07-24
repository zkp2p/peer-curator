import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

interface SurfaceCheck {
  producer: string;
  ref: string;
  surface: string;
  status: "compatible" | "incompatible";
  missing: string[];
}

const workspace = resolve(process.env.WORKSPACE_ROOT ?? "..");
const contractsRepo = resolve(workspace, "zkp2p-v2-contracts");
const indexerRepo = resolve(workspace, "zkp2p-indexer");
const curatorRepo = resolve(workspace, "curator");

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
const productionCuratorSchema = show(curatorRepo, "origin/releases/prod", "prisma/schema.prisma");

const runtimeChecks = [
  check({
    producer: "zkp2p-contracts",
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
  check({
    producer: "curator",
    ref: "origin/releases/prod",
    surface: "BlockedWallet",
    content: productionCuratorSchema,
    required: ["model BlockedWallet", "walletAddress String"],
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

process.stdout.write(
  `${JSON.stringify(
    {
      runtimeChecks,
      forwardChecks,
      note: "Forward incompatibility is known and must be resolved before indexer main is promoted to production.",
    },
    null,
    2,
  )}\n`,
);

if (runtimeChecks.some((item) => item.status === "incompatible")) {
  process.exitCode = 1;
}
