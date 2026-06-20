import { describe, expect, it } from "vitest";
import { createSecretRedactor, maskSecrets } from "../src/masking.js";

describe("maskSecrets", () => {
  it("masks GitHub tokens", () => {
    expect(maskSecrets("token github_pat_1234567890abcdef")).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(maskSecrets("token ghs_1234567890abcdef")).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(maskSecrets("authorization: bearer gho_1234567890abcdef")).toBe(
      "authorization: bearer [REDACTED_GITHUB_TOKEN]",
    );
  });

  it("masks tokens split across stream chunks", () => {
    const redact = createSecretRedactor();

    const first = redact("prefix ghs_123");
    const second = redact("4567890abcdef suffix", true);

    expect(first).toBe("prefix ");
    expect(second).toBe("[REDACTED_GITHUB_TOKEN] suffix");
  });
});
