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
  resolve("../../.."),
  resolve("../../../../.."),
  resolve(".."),
  resolve("../.."),
];
const workspace =
  workspaceCandidates.find(
    (candidate) =>
      (existsSync(resolve(candidate, "projects/core/zkp2p-v2-contracts")) &&
        existsSync(resolve(candidate, "projects/core/zkp2p-indexer"))) ||
      (existsSync(resolve(candidate, "zkp2p-v2-contracts")) &&
        existsSync(resolve(candidate, "zkp2p-indexer"))),
  ) ?? workspaceCandidates[0];
if (!workspace) {
  throw new Error("Unable to resolve the workspace root");
}
const contractsRepo = existsSync(resolve(workspace, "projects/core/zkp2p-v2-contracts"))
  ? resolve(workspace, "projects/core/zkp2p-v2-contracts")
  : resolve(workspace, "zkp2p-v2-contracts");
const indexerRepo = existsSync(resolve(workspace, "projects/core/zkp2p-indexer"))
  ? resolve(workspace, "projects/core/zkp2p-indexer")
  : resolve(workspace, "zkp2p-indexer");

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

function checkAddressGroupBinding(input: {
  ref: string;
  surface: string;
  content: string;
}): SurfaceCheck {
  const hasNonzeroAddress =
    /- name: AddressGroupRegistry\s*\n\s+address:\s*["']0x(?!0{40})[0-9a-fA-F]{40}["']/m.test(
      input.content,
    );
  return {
    producer: "zkp2p-indexer",
    ref: input.ref,
    surface: input.surface,
    status: hasNonzeroAddress ? "compatible" : "incompatible",
    missing: hasNonzeroAddress ? [] : ["nonzero AddressGroupRegistry address binding"],
  };
}

const contractSource = show(
  contractsRepo,
  "origin/main",
  "contracts/registries/AddressGroupRegistry.sol",
);
const contractPaymentMethodSources = ["paypal", "venmo", "cashapp"]
  .map((name) => show(contractsRepo, "origin/main", `deployments/verifiers/${name}.ts`))
  .join("\n");
const mainIndexerSchema = show(indexerRepo, "origin/main", "schema.graphql");
const mainIndexerProductionConfig = show(indexerRepo, "origin/main", "config.base_prod.yaml");
const mainIndexerStagingConfig = show(indexerRepo, "origin/main", "config.base_staging.yaml");
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
      "bytes32 _groupId",
    ],
  }),
  check({
    producer: "zkp2p-v2-contracts",
    ref: "origin/main",
    surface: "canonical chargebackable payment-method mappings",
    content: contractPaymentMethodSources,
    required: [
      'calculatePaymentMethodHash("paypal")',
      'calculatePaymentMethodHash("venmo")',
      'calculatePaymentMethodHash("cashapp")',
    ],
  }),
  check({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    surface: "chargebackable platform aggregate schema",
    content: mainIndexerSchema,
    required: [
      "type TakerPlatformStats",
      "chainId: Int!",
      "taker: String!",
      "paymentMethodHash: String!",
      "totalAmountTaken: BigInt!",
    ],
  }),
];

const forwardChecks: SurfaceCheck[] = [];

const membershipPrerequisiteChecks = [
  check({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    surface: "AddressGroupRegistry event source",
    content: mainIndexerProductionConfig,
    required: [
      "name: AddressGroupRegistry",
      "MemberAdded(bytes32 indexed groupId, address indexed member)",
      "MemberRemoved(bytes32 indexed groupId, address indexed member)",
    ],
  }),
  check({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    surface: "current address-group membership schema",
    content: mainIndexerSchema,
    required: [
      "type AddressGroup {",
      "memberCount: Int!",
      "type AddressGroupMember {",
      "groupEntityId: String!",
      "member: String!",
    ],
  }),
  check({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    surface: "current address-group membership handler",
    content: mainAddressGroupHandler,
    required: [
      "context.AddressGroupMember.set",
      "context.AddressGroupMember.deleteUnsafe",
      "memberCount: group.memberCount + 1",
      "memberCount: Math.max(0, group.memberCount - 1)",
    ],
  }),
  checkAddressGroupBinding({
    ref: "origin/main",
    surface: "staging AddressGroupRegistry source binding",
    content: mainIndexerStagingConfig,
  }),
  checkAddressGroupBinding({
    ref: "origin/main",
    surface: "production AddressGroupRegistry source binding",
    content: mainIndexerProductionConfig,
  }),
];

process.stdout.write(
  `${JSON.stringify(
    {
      runtimeChecks,
      forwardChecks,
      membershipPrerequisiteChecks,
      note: "Chargebackable platform aggregates and every current-membership prerequisite must remain compatible before rollout.",
    },
    null,
    2,
  )}\n`,
);

if (
  [...runtimeChecks, ...forwardChecks, ...membershipPrerequisiteChecks].some(
    (item) => item.status === "incompatible",
  )
) {
  process.exitCode = 1;
}
