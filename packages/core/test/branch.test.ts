import { describe, expect, it } from "vitest";
import { createWorkBranchName } from "../src/branch.js";

describe("createWorkBranchName", () => {
  it("creates stable agent branch names", () => {
    expect(createWorkBranchName("rec123", "Fix Login Button")).toBe("agent/rec123-fix-login-button");
  });

  it("truncates long titles and appends attempt suffix", () => {
    expect(createWorkBranchName("rec123", "A".repeat(120), 3)).toBe(
      "agent/rec123-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-3",
    );
  });
});
