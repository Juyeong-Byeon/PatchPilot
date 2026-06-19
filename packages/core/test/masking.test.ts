import { describe, expect, it } from "vitest";
import { maskSecrets } from "../src/masking.js";

describe("maskSecrets", () => {
  it("masks GitHub tokens", () => {
    expect(maskSecrets("token github_pat_1234567890abcdef")).toContain("[REDACTED_GITHUB_TOKEN]");
  });
});
