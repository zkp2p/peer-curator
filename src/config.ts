import "dotenv/config";

import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  type GroupsConfig,
  groupKey,
  normalizeAddress,
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
  RPC_URL: z.string().optional(),
  GROUPS_CONFIG_PATH: z.string().default("config/groups.json"),
  GROUPS_CONFIG_JSON: z.string().optional(),
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
  MAX_TOTAL_ADDS: nonNegativeInteger("3000"),
  MAX_TOTAL_REMOVALS: nonNegativeInteger("100"),
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
      z.object({
        scope: z.enum(POLICY_SCOPES),
        tier: z.enum(TIERS),
        groupId: z.string().regex(/^[1-9]\d*$/),
        minimumMembers: z.number().int().nonnegative(),
      }),
    )
    .length(6),
});

export type Command = "calculate" | "verify" | "plan" | "sync";

export interface RuntimeSettings {
  command: Command;
  chainId: number;
  indexerUrl: string;
  indexerApiKey?: string;
  rpcUrl?: string;
  groups?: GroupsConfig;
  execute: boolean;
  groupAdminPrivateKey?: `0x${string}`;
  requireZeroResolver: boolean;
  allowInitialSeed: boolean;
  batchSize: number;
  snapshotConfirmations: number;
  maxTotalAdds: number;
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

  const ids = new Set(groups.groups.map((group) => group.groupId.toString()));
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

async function readGroupsConfig(
  inlineJson: string | undefined,
  path: string,
): Promise<GroupsConfig> {
  const raw = inlineJson ?? (await readFile(path, "utf8"));
  const parsed = groupFileSchema.parse(JSON.parse(raw));
  const result: GroupsConfig = {
    chainId: parsed.chainId,
    registryAddress: normalizeAddress(parsed.registryAddress, "registryAddress"),
    registryDeploymentBlock: BigInt(parsed.registryDeploymentBlock),
    groups: parsed.groups.map((group) => ({
      scope: group.scope as PolicyScope,
      tier: group.tier as Tier,
      groupId: BigInt(group.groupId),
      minimumMembers: group.minimumMembers,
    })),
  };
  validateGroupCoverage(result);
  return result;
}

export async function loadSettings(command: Command): Promise<RuntimeSettings> {
  const env = envSchema.parse(process.env);
  if (env.MAX_REMOVAL_BPS_PER_GROUP > 10_000) {
    throw new Error("MAX_REMOVAL_BPS_PER_GROUP cannot exceed 10000");
  }
  if (env.BATCH_SIZE > 200) {
    throw new Error("BATCH_SIZE cannot exceed 200");
  }

  const groups =
    command === "plan" || command === "sync"
      ? await readGroupsConfig(env.GROUPS_CONFIG_JSON, env.GROUPS_CONFIG_PATH)
      : undefined;
  if (groups && groups.chainId !== env.CHAIN_ID) {
    throw new Error("CHAIN_ID does not match the group configuration");
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
    indexerUrl: env.INDEXER_GRAPHQL_URL,
    ...(env.INDEXER_API_KEY ? { indexerApiKey: env.INDEXER_API_KEY } : {}),
    ...(env.RPC_URL ? { rpcUrl: env.RPC_URL } : {}),
    ...(groups ? { groups } : {}),
    execute: command === "sync" && env.EXECUTE,
    ...(env.GROUP_ADMIN_PRIVATE_KEY
      ? { groupAdminPrivateKey: env.GROUP_ADMIN_PRIVATE_KEY as `0x${string}` }
      : {}),
    requireZeroResolver: env.REQUIRE_ZERO_RESOLVER,
    allowInitialSeed: env.ALLOW_INITIAL_SEED,
    batchSize: env.BATCH_SIZE,
    snapshotConfirmations: env.SNAPSHOT_CONFIRMATIONS,
    maxTotalAdds: env.MAX_TOTAL_ADDS,
    maxTotalRemovals: env.MAX_TOTAL_REMOVALS,
    maxRemovalBpsPerGroup: env.MAX_REMOVAL_BPS_PER_GROUP,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    logLevel: env.LOG_LEVEL,
  };
}
