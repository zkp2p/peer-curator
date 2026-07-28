import { describe, expect, it } from "vitest";
import { summarizeError } from "../src/logger.js";

describe("summarizeError", () => {
  it("uses a short public message without stack or request details", () => {
    const error = Object.assign(
      new Error(
        "Request failed at https://rpc.example/v2/secret\n" +
          'Request body: {"params":["0x02abcdef"]}\n' +
          "member 0x1111111111111111111111111111111111111111",
      ),
      { shortMessage: "Missing or invalid parameters.\nDouble check the request." },
    );

    expect(summarizeError(error)).toEqual({
      name: "Error",
      message: "Missing or invalid parameters.",
    });
  });

  it("redacts URLs and long hex values from fallback messages", () => {
    const summary = summarizeError(
      new Error(
        "RPC https://rpc.example/v2/secret rejected 0x1111111111111111111111111111111111111111",
      ),
    );

    expect(summary.message).toBe("RPC [REDACTED_URL] rejected [REDACTED_HEX]");
  });
});
