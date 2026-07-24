import pino from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    base: null,
    redact: {
      paths: [
        "indexerApiKey",
        "rpcUrl",
        "groupAdminPrivateKey",
        "*.address",
        "*.addresses",
        "members",
      ],
      censor: "[REDACTED]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
