import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { V2_CHARGEBACK_VERIFIER_METHOD_ENTRIES } from "../src/blockPinnedSnapshot.js";

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
  const bindings = [
    ...input.content.matchAll(
      /- name: AddressGroupRegistry\s*\n\s+address:\s*["']0x(?!0{40})[0-9a-fA-F]{40}["']/gm,
    ),
  ];
  const hasExactlyOneNonzeroAddress = bindings.length === 1;
  return {
    producer: "zkp2p-indexer",
    ref: input.ref,
    surface: input.surface,
    status: hasExactlyOneNonzeroAddress ? "compatible" : "incompatible",
    missing: hasExactlyOneNonzeroAddress
      ? []
      : ["exactly one nonzero AddressGroupRegistry address binding"],
  };
}

function checkLegacyVerifierMapping(content: string): SurfaceCheck {
  const missing = V2_CHARGEBACK_VERIFIER_METHOD_ENTRIES.filter(
    ([verifier, method]) =>
      !new RegExp(`"${verifier}"\\s*:\\s*\\n?\\s*lookups\\.nameToHash\\.${method}`, "i").test(
        content,
      ),
  ).map(([, method]) => `reviewed V2 ${method} verifier mapping`);
  return {
    producer: "zkp2p-indexer",
    ref: "origin/main",
    surface: "legacy V2 chargeback verifier mapping",
    status: missing.length === 0 ? "compatible" : "incompatible",
    missing,
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
const mainIndexerEventSchema = [
  show(indexerRepo, "origin/main", "schema/events_v2.graphql"),
  show(indexerRepo, "origin/main", "schema/events_v21.graphql"),
  show(indexerRepo, "origin/main", "schema/events_v3.graphql"),
].join("\n");
const mainIndexerIntentHandlers = [
  show(indexerRepo, "origin/main", "src/handlers/v2/intentHandlers.ts"),
  show(indexerRepo, "origin/main", "src/handlers/v21/orchestrator_intents.ts"),
  show(indexerRepo, "origin/main", "src/handlers/v22/EventHandler_v22.ts"),
  show(indexerRepo, "origin/main", "src/handlers/v3/orchestrator_v3.ts"),
].join("\n");
const mainIndexerPaymentMethods = show(indexerRepo, "origin/main", "src/utils/paymentMethods.ts");
const mainTakerPlatformStatsProducer = [
  show(indexerRepo, "origin/main", "src/services/takerPlatformStats.ts"),
  show(indexerRepo, "origin/main", "src/handlers/v2/taker_stats.ts"),
  show(indexerRepo, "origin/main", "src/handlers/v21/taker_stats.ts"),
].join("\n");
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
  check({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    surface: "chargebackable platform aggregate producer",
    content: mainTakerPlatformStatsProducer,
    required: [
      "buildTakerPlatformStatsId",
      "taker.toLowerCase()",
      "paymentMethodHash.toLowerCase()",
      "totalAmountTaken: stats.totalAmountTaken + args.amount",
      "args.context.TakerPlatformStats.set(updated)",
      "recordTakerPlatformFill({",
      "paymentMethodHash: intentBefore.paymentMethodHash",
    ],
  }),
  check({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    surface: "block-pinned intent event schemas",
    content: mainIndexerEventSchema,
    required: [
      "type Escrow_V2_IntentSignaled",
      "verifier: String!",
      "owner: String!",
      "type Escrow_V2_IntentFulfilled",
      "type Orchestrator_V21_IntentSignaled",
      "paymentMethod: String!",
      "type Orchestrator_V21_IntentFulfilled",
      "amount: BigInt!",
      "type AddressGroupRegistry_GroupCreated",
      "type AddressGroupRegistry_MemberAdded",
      "type AddressGroupRegistry_MemberRemoved",
    ],
  }),
  check({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    surface: "block-pinned intent event producers",
    content: mainIndexerIntentHandlers,
    required: [
      "context.Escrow_V2_IntentSignaled.set",
      "context.Escrow_V2_IntentFulfilled.set",
      "context.Orchestrator_V21_IntentSignaled.set",
      "context.Orchestrator_V21_IntentFulfilled.set",
      "onOrchestratorIntentSignaled(",
      "onOrchestratorIntentFulfilled(",
    ],
  }),
  checkLegacyVerifierMapping(mainIndexerPaymentMethods),
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
      "context.AddressGroupRegistry_GroupCreated.set",
      "context.AddressGroupRegistry_MemberAdded.set",
      "context.AddressGroupRegistry_MemberRemoved.set",
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
      note: "Block-pinned lifecycle/group events, chargeback aggregates, and every current-membership verification prerequisite must remain compatible before rollout.",
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
