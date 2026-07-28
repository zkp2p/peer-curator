import pino from "pino";

export interface ErrorSummary {
  name: string;
  message: string;
}

function sanitizeErrorText(value: string): string {
  const [firstLine = ""] = value.split(/\r?\n/, 1);
  return firstLine
    .replace(/https?:\/\/\S+/giu, "[REDACTED_URL]")
    .replace(/0x[0-9a-f]{40,}/giu, "[REDACTED_HEX]")
    .slice(0, 240);
}

export function summarizeError(error: unknown): ErrorSummary {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: "Unknown failure" };
  }
  const shortMessage = Reflect.get(error, "shortMessage");
  const message = typeof shortMessage === "string" ? shortMessage : error.message;
  return {
    name: error.name,
    message: sanitizeErrorText(message) || "Failure without a public error message",
  };
}

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
