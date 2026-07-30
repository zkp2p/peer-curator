import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  V2_CHARGEBACK_VERIFIER_METHOD_ENTRIES,
  V2_HISTORY_ESCROW_BY_ENVIRONMENT,
  V2_HISTORY_REGISTRY_BY_ENVIRONMENT,
  type V2HistoryEnvironment,
} from "../src/blockPinnedSnapshot.js";

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

function extractGraphqlType(content: string, typeName: string): string {
  const header = new RegExp(`(?:^|\\n)type\\s+${typeName}\\s*\\{`, "m").exec(content);
  if (!header) return "";
  const start = header.index + (header[0].startsWith("\n") ? 1 : 0);
  const openBrace = content.indexOf("{", start);
  if (openBrace < 0) return "";
  let depth = 0;
  for (let index = openBrace; index < content.length; index += 1) {
    const character = content[index];
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return content.slice(start, index + 1);
    }
  }
  return "";
}

function checkGraphqlType(input: {
  producer: string;
  ref: string;
  typeName: string;
  content: string;
  requiredFields: string[];
}): SurfaceCheck {
  return check({
    producer: input.producer,
    ref: input.ref,
    surface: `${input.typeName} GraphQL type`,
    content: extractGraphqlType(input.content, input.typeName),
    required: [`type ${input.typeName}`, ...input.requiredFields],
  });
}

function checkAddressGroupBinding(input: {
  ref: string;
  surface: string;
  content: string;
  environment: V2HistoryEnvironment;
}): SurfaceCheck {
  const bindings = [
    ...input.content.matchAll(
      /- name: AddressGroupRegistry\s*\n\s+address:\s*["'](0x(?!0{40})[0-9a-fA-F]{40})["']/gm,
    ),
  ];
  const expectedAddress = V2_HISTORY_REGISTRY_BY_ENVIRONMENT[input.environment];
  const hasExactBinding =
    bindings.length === 1 && bindings[0]?.[1]?.toLowerCase() === expectedAddress;
  return {
    producer: "zkp2p-indexer",
    ref: input.ref,
    surface: input.surface,
    status: hasExactBinding ? "compatible" : "incompatible",
    missing: hasExactBinding
      ? []
      : [`exact ${input.environment} AddressGroupRegistry address binding`],
  };
}

function checkLegacyVerifierMapping(content: string): SurfaceCheck {
  const missing = V2_CHARGEBACK_VERIFIER_METHOD_ENTRIES.filter(
    ([verifier, method]) =>
      !new RegExp(`"${verifier}"\\s*:\\s*\\n?\\s*lookups\\.nameToHash\\.${method}`, "i").test(
        content,
      ),
  ).map(([, method]) => `reviewed V2 ${method} verifier mapping`);
  const baseStart = content.indexOf("export const BASE_MAINNET_DEPLOYMENTS");
  const baseEnd = content.indexOf("const BASE_MAINNET_VERIFIER_TO_METHOD_HASH");
  const baseSection =
    baseStart >= 0 && baseEnd > baseStart ? content.slice(baseStart, baseEnd) : "";
  for (const method of ["paypal", "venmo", "cashapp"]) {
    const count = [...baseSection.matchAll(new RegExp(`lookups\\.nameToHash\\.${method}`, "g"))]
      .length;
    if (count !== 2) {
      missing.push(`exactly two Base V2 ${method} verifier mappings`);
    }
  }
  return {
    producer: "zkp2p-indexer",
    ref: "origin/main",
    surface: "legacy V2 chargeback verifier mapping",
    status: missing.length === 0 ? "compatible" : "incompatible",
    missing,
  };
}

function checkV2SourceBinding(input: {
  environment: V2HistoryEnvironment;
  config: string;
  paymentMethods: string;
  allowDisabledSource: boolean;
}): SurfaceCheck {
  const deploymentStart = input.paymentMethods.indexOf(`  ${input.environment}: {`);
  const deploymentEnd =
    input.environment === "staging"
      ? input.paymentMethods.indexOf("\n  prod: {", deploymentStart)
      : input.paymentMethods.indexOf("\n};", deploymentStart);
  const deploymentSection =
    deploymentStart >= 0 && deploymentEnd > deploymentStart
      ? input.paymentMethods.slice(deploymentStart, deploymentEnd)
      : "";
  const mappedEscrow = /v2Escrow:\s*"(0x[0-9a-fA-F]{40})"\.toLowerCase\(\)/.exec(
    deploymentSection,
  )?.[1];
  const configuredEscrow = /- name: Escrow_V2\s*\n\s+address:\s*["'](0x[0-9a-fA-F]{40})["']/m.exec(
    input.config,
  )?.[1];
  const expectedEscrow = V2_HISTORY_ESCROW_BY_ENVIRONMENT[input.environment];
  const constantMatches =
    mappedEscrow !== undefined && mappedEscrow.toLowerCase() === expectedEscrow;
  const sourceMatches =
    configuredEscrow !== undefined &&
    mappedEscrow !== undefined &&
    (configuredEscrow.toLowerCase() === mappedEscrow.toLowerCase() ||
      (input.allowDisabledSource &&
        configuredEscrow.toLowerCase() === "0x0000000000000000000000000000000000000000"));
  const missing = V2_CHARGEBACK_VERIFIER_METHOD_ENTRIES.filter(
    ([, , environment]) => environment === input.environment,
  )
    .filter(
      ([verifier, method]) =>
        !new RegExp(`"${verifier}"\\s*:\\s*\\n?\\s*lookups\\.nameToHash\\.${method}`, "i").test(
          deploymentSection,
        ),
    )
    .map(([, method]) => `${input.environment} V2 ${method} verifier mapping`);
  if (!sourceMatches) {
    missing.push(`${input.environment} Escrow_V2 source bound to its verifier mapping`);
  }
  if (!constantMatches) {
    missing.push(`${input.environment} V2 escrow constant matches upstream`);
  }
  return {
    producer: "zkp2p-indexer",
    ref: "origin/main",
    surface: `${input.environment} V2 source/verifier binding`,
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
const mainMakerPlatformStatsProducer = show(
  indexerRepo,
  "origin/main",
  "src/handlers/makerStats.ts",
);
const mainIndexerProductionConfig = show(indexerRepo, "origin/main", "config.base_prod.yaml");
const mainIndexerStagingConfig = show(indexerRepo, "origin/main", "config.base_staging.yaml");
const mainAddressGroupHandler = show(
  indexerRepo,
  "origin/main",
  "src/handlers/v3/address_group_registry.ts",
);

const blockPinnedGraphqlChecks = [
  checkGraphqlType({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    typeName: "Deposit",
    content: mainIndexerSchema,
    requiredFields: [
      "chainId: Int!",
      "escrowAddress: String!",
      "depositId: BigInt!",
      "depositor: String!",
    ],
  }),
  checkGraphqlType({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    typeName: "Escrow_V2_IntentSignaled",
    content: mainIndexerEventSchema,
    requiredFields: [
      "id: ID!",
      "intentHash: String!",
      "depositId: BigInt!",
      "verifier: String!",
      "owner: String!",
      "amount: BigInt!",
    ],
  }),
  checkGraphqlType({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    typeName: "Escrow_V2_IntentFulfilled",
    content: mainIndexerEventSchema,
    requiredFields: [
      "id: ID!",
      "intentHash: String!",
      "depositId: BigInt!",
      "verifier: String!",
      "owner: String!",
      "amount: BigInt!",
    ],
  }),
  checkGraphqlType({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    typeName: "Orchestrator_V21_IntentSignaled",
    content: mainIndexerEventSchema,
    requiredFields: [
      "id: ID!",
      "intentHash: String!",
      "escrow: String!",
      "depositId: BigInt!",
      "paymentMethod: String!",
      "owner: String!",
    ],
  }),
  checkGraphqlType({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    typeName: "Orchestrator_V21_IntentFulfilled",
    content: mainIndexerEventSchema,
    requiredFields: [
      "id: ID!",
      "intentHash: String!",
      "amount: BigInt!",
      "isManualRelease: Boolean!",
    ],
  }),
  checkGraphqlType({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    typeName: "AddressGroupRegistry_GroupCreated",
    content: mainIndexerEventSchema,
    requiredFields: ["id: ID!", "groupId: String!"],
  }),
  checkGraphqlType({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    typeName: "AddressGroupRegistry_MemberAdded",
    content: mainIndexerEventSchema,
    requiredFields: ["id: ID!", "groupId: String!", "member: String!"],
  }),
  checkGraphqlType({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    typeName: "AddressGroupRegistry_MemberRemoved",
    content: mainIndexerEventSchema,
    requiredFields: ["id: ID!", "groupId: String!", "member: String!"],
  }),
];

const aggregateGraphqlChecks = [
  checkGraphqlType({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    typeName: "MakerPlatformStats",
    content: mainIndexerSchema,
    requiredFields: [
      "chainId: Int!",
      "maker: String!",
      "paymentMethodHash: String!",
      "totalAmountTaken: BigInt!",
      "nonManualReleaseVolume: BigInt!",
      "manualReleaseVolume: BigInt!",
    ],
  }),
  checkGraphqlType({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    typeName: "TakerPlatformStats",
    content: mainIndexerSchema,
    requiredFields: [
      "chainId: Int!",
      "taker: String!",
      "paymentMethodHash: String!",
      "totalAmountTaken: BigInt!",
    ],
  }),
];

const membershipGraphqlChecks = [
  checkGraphqlType({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    typeName: "AddressGroup",
    content: mainIndexerSchema,
    requiredFields: [
      "registryAddress: String!",
      "groupId: String!",
      "curator: String!",
      "memberCount: Int!",
    ],
  }),
  checkGraphqlType({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    typeName: "AddressGroupMember",
    content: mainIndexerSchema,
    requiredFields: [
      "registryAddress: String!",
      "groupId: String!",
      "groupEntityId: String!",
      "member: String!",
    ],
  }),
];

const runtimeChecks = [
  check({
    producer: "zkp2p-v2-contracts",
    ref: "origin/main",
    surface: "AddressGroupRegistry",
    content: contractSource,
    required: [
      "function createGroup(string calldata _name) external override returns (bytes32 groupId)",
      "function addMembers",
      "function removeMembers",
      "event GroupCreated(bytes32 indexed groupId, address indexed curator, string name);",
      "event MemberAdded",
      "event MemberRemoved",
      "function getGroup",
      "bytes32 _groupId",
    ],
  }),
  ...blockPinnedGraphqlChecks,
  ...aggregateGraphqlChecks,
  check({
    producer: "zkp2p-indexer",
    ref: "origin/main",
    surface: "maker chargeback volume aggregate producer",
    content: mainMakerPlatformStatsProducer,
    required: ["nonManualReleaseVolume:", "manualReleaseVolume:", "manualReleaseDelta === 0"],
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
  checkV2SourceBinding({
    environment: "staging",
    config: mainIndexerStagingConfig,
    paymentMethods: mainIndexerPaymentMethods,
    allowDisabledSource: true,
  }),
  checkV2SourceBinding({
    environment: "prod",
    config: mainIndexerProductionConfig,
    paymentMethods: mainIndexerPaymentMethods,
    allowDisabledSource: false,
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
  ...membershipGraphqlChecks,
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
    environment: "staging",
  }),
  checkAddressGroupBinding({
    ref: "origin/main",
    surface: "production AddressGroupRegistry source binding",
    content: mainIndexerProductionConfig,
    environment: "prod",
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
