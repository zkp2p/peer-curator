#!/usr/bin/env node

import { z } from "zod";
import { loadSettings } from "./config.js";
import { createLogger, summarizeError } from "./logger.js";
import { run } from "./runner.js";

const command = z
  .enum(["calculate", "verify", "plan", "sync"])
  .parse(process.argv[2] ?? process.env.RUN_COMMAND ?? "calculate");
const settings = await loadSettings(command);
const logger = createLogger(settings.logLevel);

try {
  const verifyAddress = process.argv.slice(3).find((argument) => argument !== "--");
  await run(settings, logger, verifyAddress);
} catch (error) {
  logger.fatal({ error: summarizeError(error) }, "Taker group reconciliation failed closed");
  process.exitCode = 1;
}
