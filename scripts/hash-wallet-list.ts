import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeAddress } from "../src/domain.js";
import { hashWallet } from "../src/staticWalletRules.js";

const inputPath = process.argv.slice(2).find((argument) => argument !== "--");
if (!inputPath) {
  throw new Error("Pass a newline-delimited or JSON wallet file: pnpm hash-wallets -- /path");
}

const filename = resolve(inputPath);
const content = await readFile(filename, "utf8");

function parseWallets(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("JSON input must be an array");
    return parsed.map((entry) => {
      if (typeof entry === "string") return entry;
      if (typeof entry === "object" && entry !== null) {
        const row = entry as Record<string, unknown>;
        const value = row.address ?? row.walletAddress;
        if (typeof value === "string") return value;
      }
      throw new Error("JSON entries must be addresses or objects with address/walletAddress");
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }
    throw error;
  }
}

const hashes = parseWallets(content)
  .map((wallet) => normalizeAddress(wallet, `wallet in ${filename}`))
  .map(hashWallet)
  .sort();

if (new Set(hashes).size !== hashes.length) {
  throw new Error("Input contains duplicate wallets");
}

process.stdout.write(`${JSON.stringify({ count: hashes.length, hashes }, null, 2)}\n`);
