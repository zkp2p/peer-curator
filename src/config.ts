import "dotenv/config";

import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  V2_HISTORY_REGISTRY_BY_ENVIRONMENT,
  type V2HistoryEnvironment,
} from "./blockPinnedSnapshot.js";
import {
  type GroupsConfig,
  groupKey,
  normalizeAddress,
  normalizeGroupId,
  type PinnedMember,
  POLICY_SCOPES,
  type PolicyScope,
  TIERS,
  type Tier,
} from "./domain.js";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalNonEmptyString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const positiveInteger = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value, context) => {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        context.addIssue({ code: "custom", message: "Must be a positive integer" });
        return z.NEVER;
      }
      return parsed;
    });

const nonNegativeInteger = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value, context) => {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        context.addIssue({ code: "custom", message: "Must be a non-negative integer" });
        return z.NEVER;
      }
      return parsed;
    });

const envSchema = z.object({
  INDEXER_GRAPHQL_URL: z.url().default("https://indexer.zkp2p.xyz/v1/graphql"),
  INDEXER_API_KEY: optionalNonEmptyString,
  CHAIN_ID: positiveInteger("8453"),
  V2_HISTORY_ENVIRONMENT: z.enum(["staging", "prod"]).optional(),
  RAILWAY_ENVIRONMENT_NAME: optionalNonEmptyString,
  RPC_URL: z.string().optional(),
  GROUPS_CONFIG_PATH: z.string().default("config/groups.json"),
  GROUPS_CONFIG_JSON: z.string().optional(),
  PINNED_MEMBERS_JSON: optionalNonEmptyString,
  EXECUTE: booleanFromString,
  GROUP_ADMIN_PRIVATE_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
  ),
  REQUIRE_ZERO_RESOLVER: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  ALLOW_INITIAL_SEED: booleanFromString,
  BATCH_SIZE: positiveInteger("100"),
  SNAPSHOT_CONFIRMATIONS: nonNegativeInteger("20"),
  MAX_PLANNED_ADDS: nonNegativeInteger("1500"),
  MAX_EXECUTED_ADDS_PER_RUN: positiveInteger("1000"),
  MAX_TOTAL_REMOVALS: nonNegativeInteger("100"),
  MAX_REMOVAL_WALLETS: nonNegativeInteger("50"),
  ALLOW_MIGRATION_REMOVALS: booleanFromString,
  MAX_REMOVAL_BPS_PER_GROUP: nonNegativeInteger("500"),
  REQUEST_TIMEOUT_MS: positiveInteger("20000"),
  LOG_LEVEL: z.string().default("info"),
});

const groupFileSchema = z.object({
  chainId: z.literal(8453),
  registryAddress: z.string(),
  registryDeploymentBlock: z.string().regex(/^\d+$/),
  groups: z
    .array(
      z
        .object({
          scope: z.enum(POLICY_SCOPES),
          tier: z.enum(TIERS),
          groupId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
          minimumMembers: z.number().int().nonnegative(),
          maximumMembers: z.number().int().positive(),
        })
        .refine((group) => group.maximumMembers >= group.minimumMembers, {
          message: "maximumMembers must be greater than or equal to minimumMembers",
        }),
    )
    .length(3),
});

export type Command = "calculate" | "verify" | "plan" | "sync";

export interface RuntimeSettings {
  command: Command;
  chainId: number;
  v2HistoryEnvironment: V2HistoryEnvironment;
  indexerUrl: string;
  indexerApiKey?: string;
  rpcUrl?: string;
  groups?: GroupsConfig;
  pinnedMembers: PinnedMember[];
  execute: boolean;
  groupAdminPrivateKey?: `0x${string}`;
  requireZeroResolver: boolean;
  allowInitialSeed: boolean;
  batchSize: number;
  snapshotConfirmations: number;
  maxPlannedAdds: number;
  maxExecutedAddsPerRun: number;
  maxRemovalWallets: number;
  allowMigrationRemovals: boolean;
  maxTotalRemovals: number;
  maxRemovalBpsPerGroup: number;
  requestTimeoutMs: number;
  logLevel: string;
}

function validateGroupCoverage(groups: GroupsConfig): void {
  const keys = new Set(groups.groups.map((group) => groupKey(group.scope, group.tier)));
  if (keys.size !== groups.groups.length) {
    throw new Error("Group configuration contains duplicate scope/tier entries");
  }

  const ids = new Set(groups.groups.map((group) => group.groupId));
  if (ids.size !== groups.groups.length) {
    throw new Error("Group configuration reuses a groupId");
  }

  for (const scope of POLICY_SCOPES) {
    for (const tier of TIERS) {
      if (!keys.has(groupKey(scope, tier))) {
        throw new Error(`Missing group configuration for ${scope}:${tier}`);
      }
    }
  }
}

export function parseGroupsConfig(raw: string): GroupsConfig {
  const parsed = groupFileSchema.parse(JSON.parse(raw));
  const result: GroupsConfig = {
    chainId: parsed.chainId,
    registryAddress: normalizeAddress(parsed.registryAddress, "registryAddress"),
    registryDeploymentBlock: BigInt(parsed.registryDeploymentBlock),
    groups: parsed.groups.map((group) => ({
      scope: group.scope as PolicyScope,
      tier: group.tier as Tier,
      groupId: normalizeGroupId(group.groupId),
      minimumMembers: group.minimumMembers,
      maximumMembers: group.maximumMembers,
    })),
  };
  validateGroupCoverage(result);
  return result;
}

const pinnedMembersSchema = z
  .array(
    z.object({
      scope: z.enum(POLICY_SCOPES),
      tier: z.enum(TIERS),
      address: z.string(),
    }),
  )
  .max(100);

export function parsePinnedMembers(raw: string | undefined): PinnedMember[] {
  if (!raw) return [];
  const parsed = pinnedMembersSchema.parse(JSON.parse(raw));
  const members = parsed.map((member) => ({
    scope: member.scope as PolicyScope,
    tier: member.tier as Tier,
    address: normalizeAddress(member.address, "pinned member address"),
  }));
  const uniqueMembers = new Set(
    members.map((member) => `${member.scope}:${member.tier}:${member.address}`),
  );
  if (uniqueMembers.size !== members.length) {
    throw new Error("Pinned member configuration contains duplicate entries");
  }
  return members;
}

async function readGroupsConfig(
  inlineJson: string | undefined,
  path: string,
): Promise<GroupsConfig> {
  return parseGroupsConfig(inlineJson ?? (await readFile(path, "utf8")));
}

export async function loadSettings(command: Command): Promise<RuntimeSettings> {
  const env = envSchema.parse(process.env);
  const reconciliationRun = command === "plan" || command === "sync";
  if (reconciliationRun && !env.V2_HISTORY_ENVIRONMENT) {
    throw new Error("V2_HISTORY_ENVIRONMENT is required for plan and sync");
  }
  const v2HistoryEnvironment = env.V2_HISTORY_ENVIRONMENT ?? "prod";
  const expectedV2Environment =
    env.RAILWAY_ENVIRONMENT_NAME === "production"
      ? "prod"
      : env.RAILWAY_ENVIRONMENT_NAME === "staging"
        ? "staging"
        : undefined;
  if (
    reconciliationRun &&
    expectedV2Environment &&
    v2HistoryEnvironment !== expectedV2Environment
  ) {
    throw new Error("V2_HISTORY_ENVIRONMENT does not match the Railway environment");
  }
  if (env.MAX_REMOVAL_BPS_PER_GROUP > 10_000) {
    throw new Error("MAX_REMOVAL_BPS_PER_GROUP cannot exceed 10000");
  }
  if (env.BATCH_SIZE > 200) {
    throw new Error("BATCH_SIZE cannot exceed 200");
  }

  const groups = reconciliationRun
    ? await readGroupsConfig(env.GROUPS_CONFIG_JSON, env.GROUPS_CONFIG_PATH)
    : undefined;
  if (groups && groups.chainId !== env.CHAIN_ID) {
    throw new Error("CHAIN_ID does not match the group configuration");
  }
  if (
    groups &&
    groups.registryAddress !== V2_HISTORY_REGISTRY_BY_ENVIRONMENT[v2HistoryEnvironment]
  ) {
    throw new Error(
      "V2_HISTORY_ENVIRONMENT does not match the configured AddressGroupRegistry deployment",
    );
  }
  const rpcRequired = command === "plan" || command === "sync";
  if (rpcRequired && !env.RPC_URL) {
    throw new Error("RPC_URL is required for plan and sync");
  }
  if (command === "sync" && env.EXECUTE && !env.GROUP_ADMIN_PRIVATE_KEY) {
    throw new Error("GROUP_ADMIN_PRIVATE_KEY is required when EXECUTE=true");
  }

  return {
    command,
    chainId: env.CHAIN_ID,
    v2HistoryEnvironment,
    indexerUrl: env.INDEXER_GRAPHQL_URL,
    ...(env.INDEXER_API_KEY ? { indexerApiKey: env.INDEXER_API_KEY } : {}),
    ...(env.RPC_URL ? { rpcUrl: env.RPC_URL } : {}),
    ...(groups ? { groups } : {}),
    pinnedMembers: parsePinnedMembers(env.PINNED_MEMBERS_JSON),
    execute: command === "sync" && env.EXECUTE,
    ...(env.GROUP_ADMIN_PRIVATE_KEY
      ? { groupAdminPrivateKey: env.GROUP_ADMIN_PRIVATE_KEY as `0x${string}` }
      : {}),
    requireZeroResolver: env.REQUIRE_ZERO_RESOLVER,
    allowInitialSeed: env.ALLOW_INITIAL_SEED,
    batchSize: env.BATCH_SIZE,
    snapshotConfirmations: env.SNAPSHOT_CONFIRMATIONS,
    maxPlannedAdds: env.MAX_PLANNED_ADDS,
    maxExecutedAddsPerRun: env.MAX_EXECUTED_ADDS_PER_RUN,
    maxRemovalWallets: env.MAX_REMOVAL_WALLETS,
    allowMigrationRemovals: env.ALLOW_MIGRATION_REMOVALS,
    maxTotalRemovals: env.MAX_TOTAL_REMOVALS,
    maxRemovalBpsPerGroup: env.MAX_REMOVAL_BPS_PER_GROUP,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    logLevel: env.LOG_LEVEL,
  };
}
