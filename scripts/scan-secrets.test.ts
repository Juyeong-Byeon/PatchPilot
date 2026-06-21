import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations.
import { maskMatch, scanText, SECRET_RULES } from "./scan-secrets.mjs";

describe("scan-secrets", () => {
  it("detects high-confidence credential shapes", () => {
    const cases: Array<[string, string]> = [
      ["aws-access-key-id", "AKIAIOSFODNN7EXAMPLE"],
      ["github-token", "ghp_0123456789abcdefghijklmnopqrstuvwxyz"],
      ["github-fine-grained-token", "github_pat_0123456789abcdefghijkl_mnopqrstuvwxyz"],
      ["private-key-header", "-----BEGIN RSA PRIVATE KEY-----"],
      ["openai-key", "sk-0123456789abcdefghij0123"],
    ];
    for (const [rule, sample] of cases) {
      const findings = scanText(`const x = "${sample}";`);
      expect(findings.map((f: { rule: string }) => f.rule)).toContain(rule);
    }
  });

  it("returns nothing for clean text", () => {
    expect(scanText("const greeting = 'hello world';\nconst n = 42;")).toEqual([]);
  });

  it("does NOT flag innocuous token/secret assignments (generic rule dropped for repo scan)", () => {
    expect(scanText(`token: "access-key",`)).toEqual([]);
    expect(scanText(`const secret = "new-secret,old-secret";`)).toEqual([]);
    expect(SECRET_RULES.map((r: { name: string }) => r.name)).not.toContain("generic-secret-assignment");
  });

  it("honors the inline `secret-scan:allow` escape hatch", () => {
    const line = `const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyz"; // secret-scan:allow`;
    expect(scanText(line)).toEqual([]);
  });

  it("reports the 1-based line number of a finding", () => {
    const findings = scanText(`clean line\nAKIAIOSFODNN7EXAMPLE`);
    expect(findings[0]?.line).toBe(2);
  });

  it("masks the matched secret instead of echoing it", () => {
    const masked = maskMatch("ghp_0123456789abcdefghijklmnopqrstuvwxyz");
    expect(masked).not.toContain("0123456789abcdefghijklmnopqrstuvwxyz");
    expect(masked).toContain("ghp_");
  });
});
