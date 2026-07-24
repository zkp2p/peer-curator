import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Address } from "viem";
import { calculateDesiredSnapshot } from "../src/calculate.js";
import { loadSettings } from "../src/config.js";
import { normalizeAddress, POLICY_SCOPES, type PolicyScope, TIERS } from "../src/domain.js";

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

  const localUnion = new Set<Address>();
  const calculatedUnion = new Set<Address>();
  const tierResults = [];

  for (const tier of TIERS) {
    const local = await readMemberFile(resolve(scopeDirectory.path, `${tier.toLowerCase()}.txt`));
    if (tier === "PRO" && !scopeDirectory.alreadyThreeTier) {
      const formerTopTier = await readMemberFile(resolve(scopeDirectory.path, "platinum.txt"));
      for (const address of formerTopTier) local.add(address);
    }
    const current = snapshot.membersByTier[tier];
    for (const address of local) localUnion.add(address);
    for (const address of current) calculatedUnion.add(address);

    tierResults.push({
      tier,
      local: local.size,
      calculated: current.size,
      overlap: local.size - countDifference(local, current),
      calculatedOnly: countDifference(current, local),
      localOnly: countDifference(local, current),
    });
  }

  results.push({
    scope,
    summary: {
      local: localUnion.size,
      calculated: calculatedUnion.size,
      overlap: localUnion.size - countDifference(localUnion, calculatedUnion),
      calculatedOnly: countDifference(calculatedUnion, localUnion),
      localOnly: countDifference(localUnion, calculatedUnion),
    },
    tiers: tierResults,
  });
}

process.stdout.write(
  `${JSON.stringify({ comparedAt: calculated.calculatedAt, results }, null, 2)}\n`,
);
