import { describe, expect, it } from "vitest";
import { collectSecretScanTargets, scanForSecrets } from "../src/secret-scan.js";

describe("scanForSecrets", () => {
  it("detects AWS access key ids", () => {
    const findings = scanForSecrets(["AWS_KEY=AKIAIOSFODNN7EXAMPLE in config"]);
    expect(findings.map((finding) => finding.rule)).toContain("aws-access-key-id");
  });

  it("detects PEM private-key headers", () => {
    const findings = scanForSecrets(["-----BEGIN RSA PRIVATE KEY-----\nMIIE..."]);
    expect(findings.map((finding) => finding.rule)).toContain("private-key-header");
  });

  it("detects github tokens and never stores the raw secret", () => {
    const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    const findings = scanForSecrets([`token leaked: ${token}`]);
    expect(findings.map((finding) => finding.rule)).toContain("github-token");
    // The masked snippet must not contain the raw token.
    for (const finding of findings) {
      expect(finding.maskedSnippet).not.toContain(token);
    }
  });

  it("detects generic secret assignments", () => {
    const findings = scanForSecrets([`password = "hunter2hunter2"`]);
    expect(findings.map((finding) => finding.rule)).toContain("generic-secret-assignment");
  });

  it("returns no findings for clean text", () => {
    expect(scanForSecrets(["src/login.ts", "Fix login redirect", "npm test", undefined])).toEqual([]);
  });

  it("dedupes a repeated secret to a single finding", () => {
    const findings = scanForSecrets(["AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"]);
    expect(findings.filter((finding) => finding.rule === "aws-access-key-id")).toHaveLength(1);
  });
});

describe("collectSecretScanTargets", () => {
  it("pulls changed files, commit messages, test fields, and PR title", () => {
    const targets = collectSecretScanTargets({
      schemaVersion: "1.0",
      runId: "run_1",
      jobId: "job_1",
      ticketId: "ts_1",
      triggerVersion: "v1",
      status: "completed",
      targetBranch: "main",
      baseSha: "base",
      headSha: "head",
      pushSha: "0123456789abcdef0123456789abcdef01234567",
      changedFiles: ["src/a.ts"],
      commits: [{ sha: "abc", message: "commit msg" }],
      tests: [{ command: "npm test", status: "passed", summary: "ok" }],
      review: { summary: "ok", risks: [], knownLimitations: [] },
      pullRequestDraft: { title: "PR title", bodyPath: "body.md" },
      failure: null,
      retryable: false,
    });
    expect(targets).toEqual(expect.arrayContaining(["src/a.ts", "commit msg", "npm test", "ok", "PR title"]));
  });
});
