import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Address } from "viem";
import { calculateDesiredSnapshot } from "../src/calculate.js";
import { loadSettings } from "../src/config.js";
import {
  normalizeAddress,
  POLICY_SCOPES,
  type PolicyScope,
  TIERS,
  type Tier,
} from "../src/domain.js";

const seedDirectory =
  process.argv.slice(2).find((argument) => argument !== "--") ?? process.env.LOCAL_SEED_DIR;
if (!seedDirectory) {
  throw new Error("Pass the seed directory: pnpm compare:local -- /path/to/group-seeds");
}
const seedRoot = resolve(seedDirectory);

async function readMemberFile(filename: string): Promise<Set<Address>> {
  const content = await readFile(filename, "utf8");
  return new Set(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => normalizeAddress(line, filename)),
  );
}

async function findScopeDirectory(scope: PolicyScope): Promise<{
  path: string;
  alreadyThreeTier: boolean;
}> {
  for (const candidate of [
    { path: resolve(seedRoot, `${scope}-3`), alreadyThreeTier: true },
    { path: resolve(seedRoot, scope), alreadyThreeTier: false },
  ]) {
    try {
      await access(candidate.path);
      return candidate;
    } catch {
      // Try the next supported artifact layout.
    }
  }
  throw new Error(`No seed directory found for ${scope}`);
}

function countDifference(left: Set<Address>, right: Set<Address>): number {
  let count = 0;
  for (const address of left) {
    if (!right.has(address)) count += 1;
  }
  return count;
}

const settings = await loadSettings("calculate");
const calculated = await calculateDesiredSnapshot(settings);
const results = [];

for (const scope of POLICY_SCOPES) {
  const snapshot = calculated.policies.get(scope);
  if (!snapshot) throw new Error(`Calculated snapshot omitted ${scope}`);
  const scopeDirectory = await findScopeDirectory(scope);

  const seedFile = (tier: Tier) => resolve(scopeDirectory.path, `${tier.toLowerCase()}.txt`);
  const exclusiveSeeds: Record<Tier, Set<Address>> = {
    PEER: await readMemberFile(seedFile("PEER")),
    PLUS: await readMemberFile(seedFile("PLUS")),
    PRO: await readMemberFile(seedFile("PRO")),
  };
  if (!scopeDirectory.alreadyThreeTier) {
    const formerTopTier = await readMemberFile(resolve(scopeDirectory.path, "platinum.txt"));
    for (const address of formerTopTier) exclusiveSeeds.PRO.add(address);
  }

  const localUnion = new Set<Address>();
  const calculatedUnion = new Set<Address>();
  const tierResults = [];

  for (let tierIndex = 0; tierIndex < TIERS.length; tierIndex += 1) {
    const tier = TIERS[tierIndex];
    if (!tier) throw new Error(`Tier missing at index ${tierIndex}`);

    const local = new Set<Address>();
    for (let cascadeIndex = tierIndex; cascadeIndex < TIERS.length; cascadeIndex += 1) {
      const cascadeTier = TIERS[cascadeIndex];
      if (!cascadeTier) throw new Error(`Tier missing at index ${cascadeIndex}`);
      for (const address of exclusiveSeeds[cascadeTier]) local.add(address);
    }
    const current = snapshot.membersByTier[tier];
    for (const address of local) localUnion.add(address);
    for (const address of current) calculatedUnion.add(address);

    tierResults.push({
      tier,
      cumulativeLocal: local.size,
      cumulativeCalculated: current.size,
      cumulativeOverlap: local.size - countDifference(local, current),
      cumulativeCalculatedOnly: countDifference(current, local),
      cumulativeLocalOnly: countDifference(local, current),
    });
  }

  results.push({
    scope,
    summary: {
      cumulativeLocal: localUnion.size,
      cumulativeCalculated: calculatedUnion.size,
      cumulativeOverlap: localUnion.size - countDifference(localUnion, calculatedUnion),
      cumulativeCalculatedOnly: countDifference(calculatedUnion, localUnion),
      cumulativeLocalOnly: countDifference(localUnion, calculatedUnion),
    },
    tiers: tierResults,
  });
}

process.stdout.write(
  `${JSON.stringify({ comparedAt: calculated.calculatedAt, results }, null, 2)}\n`,
);
