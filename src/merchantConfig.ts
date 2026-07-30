import "dotenv/config";

import { readFile } from "node:fs/promises";
import type { Address } from "viem";
import { z } from "zod";
import {
  V2_HISTORY_REGISTRY_BY_ENVIRONMENT,
  type V2HistoryEnvironment,
} from "./blockPinnedSnapshot.js";
import { type GroupId, normalizeAddress, normalizeGroupId } from "./domain.js";

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
  RPC_URL: optionalNonEmptyString,
  MERCHANT_REGISTRY_ADDRESS: optionalNonEmptyString,
  MERCHANT_GROUP_CONFIG_PATH: z.string().default("config/merchant-group.json"),
  MERCHANT_GROUP_CONFIG_JSON: optionalNonEmptyString,
  MERCHANT_GROUP_NAME: z.string().min(1).max(120).default("Peer Makers"),
  EXECUTE: booleanFromString,
  ALLOW_MERCHANT_GROUP_CREATION: booleanFromString,
  ALLOW_INITIAL_SEED: booleanFromString,
  GROUP_ADMIN_PRIVATE_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
  ),
  BATCH_SIZE: positiveInteger("100"),
  SNAPSHOT_CONFIRMATIONS: nonNegativeInteger("20"),
  MAX_PLANNED_ADDS: nonNegativeInteger("500"),
  MAX_EXECUTED_ADDS_PER_RUN: positiveInteger("1000"),
  REQUEST_TIMEOUT_MS: positiveInteger("20000"),
  LOG_LEVEL: z.string().default("info"),
});

const groupSchema = z
  .object({
    chainId: z.literal(8453),
    registryAddress: z.string(),
    registryDeploymentBlock: z.string().regex(/^\d+$/),
    groupId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    minimumMembers: z.number().int().nonnegative(),
    maximumMembers: z.number().int().nonnegative(),
  })
  .refine((group) => group.maximumMembers >= group.minimumMembers, {
    message: "maximumMembers must be greater than or equal to minimumMembers",
  });

export type MerchantCommand = "calculate" | "create" | "plan" | "sync";

export interface MerchantGroupConfig {
  chainId: number;
  registryAddress: Address;
  registryDeploymentBlock: bigint;
  groupId: GroupId;
  minimumMembers: number;
  maximumMembers: number;
}

export interface MerchantRuntimeSettings {
  command: MerchantCommand;
  chainId: number;
  v2HistoryEnvironment: V2HistoryEnvironment;
  indexerUrl: string;
  indexerApiKey?: string;
  rpcUrl?: string;
  registryAddress?: Address;
  group?: MerchantGroupConfig;
  groupName: string;
  execute: boolean;
  allowGroupCreation: boolean;
  allowInitialSeed: boolean;
  groupAdminPrivateKey?: `0x${string}`;
  batchSize: number;
  snapshotConfirmations: number;
  maxPlannedAdds: number;
  maxExecutedAddsPerRun: number;
  requestTimeoutMs: number;
  logLevel: string;
}

export function parseMerchantGroupConfig(raw: string): MerchantGroupConfig {
  const parsed = groupSchema.parse(JSON.parse(raw));
  return {
    chainId: parsed.chainId,
    registryAddress: normalizeAddress(parsed.registryAddress, "registryAddress"),
    registryDeploymentBlock: BigInt(parsed.registryDeploymentBlock),
    groupId: normalizeGroupId(parsed.groupId),
    minimumMembers: parsed.minimumMembers,
    maximumMembers: parsed.maximumMembers,
  };
}

export async function loadMerchantSettings(
  command: MerchantCommand,
): Promise<MerchantRuntimeSettings> {
  const env = envSchema.parse(process.env);
  if (env.BATCH_SIZE > 200) throw new Error("BATCH_SIZE cannot exceed 200");
  const needsRpc = command === "create" || command === "plan" || command === "sync";
  if (needsRpc && !env.RPC_URL) {
    throw new Error("RPC_URL is required for create, plan, and sync");
  }
  if (
    (command === "create" || (command === "sync" && env.EXECUTE)) &&
    !env.GROUP_ADMIN_PRIVATE_KEY
  ) {
    throw new Error("GROUP_ADMIN_PRIVATE_KEY is required for merchant execution");
  }
  if (command === "create" && !env.MERCHANT_REGISTRY_ADDRESS) {
    throw new Error("MERCHANT_REGISTRY_ADDRESS is required for create");
  }
  const needsGroup = command === "plan" || command === "sync";
  if (needsGroup && !env.V2_HISTORY_ENVIRONMENT) {
    throw new Error("V2_HISTORY_ENVIRONMENT is required for merchant plan and sync");
  }
  const v2HistoryEnvironment = env.V2_HISTORY_ENVIRONMENT ?? "prod";
  const group = needsGroup
    ? parseMerchantGroupConfig(
        env.MERCHANT_GROUP_CONFIG_JSON ?? (await readFile(env.MERCHANT_GROUP_CONFIG_PATH, "utf8")),
      )
    : undefined;
  if (group && group.chainId !== env.CHAIN_ID) {
    throw new Error("CHAIN_ID does not match the merchant group configuration");
  }
  if (group && group.registryAddress !== V2_HISTORY_REGISTRY_BY_ENVIRONMENT[v2HistoryEnvironment]) {
    throw new Error("V2_HISTORY_ENVIRONMENT does not match the merchant group registry");
  }

  return {
    command,
    chainId: env.CHAIN_ID,
    v2HistoryEnvironment,
    indexerUrl: env.INDEXER_GRAPHQL_URL,
    ...(env.INDEXER_API_KEY ? { indexerApiKey: env.INDEXER_API_KEY } : {}),
    ...(env.RPC_URL ? { rpcUrl: env.RPC_URL } : {}),
    ...(env.MERCHANT_REGISTRY_ADDRESS
      ? { registryAddress: normalizeAddress(env.MERCHANT_REGISTRY_ADDRESS, "registry address") }
      : {}),
    ...(group ? { group } : {}),
    groupName: env.MERCHANT_GROUP_NAME,
    execute: env.EXECUTE,
    allowGroupCreation: env.ALLOW_MERCHANT_GROUP_CREATION,
    allowInitialSeed: env.ALLOW_INITIAL_SEED,
    ...(env.GROUP_ADMIN_PRIVATE_KEY
      ? { groupAdminPrivateKey: env.GROUP_ADMIN_PRIVATE_KEY as `0x${string}` }
      : {}),
    batchSize: env.BATCH_SIZE,
    snapshotConfirmations: env.SNAPSHOT_CONFIRMATIONS,
    maxPlannedAdds: env.MAX_PLANNED_ADDS,
    maxExecutedAddsPerRun: env.MAX_EXECUTED_ADDS_PER_RUN,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    logLevel: env.LOG_LEVEL,
  };
}
