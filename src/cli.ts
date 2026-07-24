#!/usr/bin/env node

import { z } from "zod";
import { loadSettings } from "./config.js";
import { createLogger } from "./logger.js";
import { run } from "./runner.js";

const command = z.enum(["calculate", "plan", "sync"]).parse(process.argv[2] ?? "calculate");
const settings = await loadSettings(command);
const logger = createLogger(settings.logLevel);

try {
  await run(settings, logger);
} catch (error) {
  logger.fatal(
    {
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { message: "Unknown failure" },
    },
    "Taker group reconciliation failed closed",
  );
  process.exitCode = 1;
}
