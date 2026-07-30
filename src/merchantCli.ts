#!/usr/bin/env node

import { z } from "zod";
import { createLogger, summarizeError } from "./logger.js";
import { loadMerchantSettings } from "./merchantConfig.js";
import { runMerchant } from "./merchantRunner.js";

const command = z
  .enum(["calculate", "create", "plan", "sync"])
  .parse(process.argv[2] ?? "calculate");
const settings = await loadMerchantSettings(command);
const logger = createLogger(settings.logLevel);

try {
  await runMerchant(settings, logger);
} catch (error) {
  logger.fatal(
    { error: summarizeError(error) },
    "Top chargeback merchant initialization failed closed",
  );
  process.exitCode = 1;
}
