import { describe, expect, it } from "vitest";
import { evaluatePolicyGate } from "../src/policy-gate.js";

const completedResult = {
  schemaVersion: "1.0" as const,
  runId: "run_1",
  jobId: "job_1",
  ticketId: "ts_1",
  triggerVersion: "v1",
  status: "completed" as const,
  targetBranch: "main",
  baseSha: "base",
  headSha: "head",
  changedFiles: ["src/login.ts"],
  commits: [{ sha: "abc", message: "Fix login" }],
  tests: [{ command: "npm test", status: "passed" as const, summary: "ok" }],
  review: { summary: "ok", risks: [], knownLimitations: [] },
  pullRequestDraft: { title: "Fix login", bodyPath: "PR_BODY.md" },
  failure: null,
  retryable: false,
};

describe("evaluatePolicyGate", () => {
  it("passes when repository is allowlisted and changed files avoid protected paths", () => {
    const gate = evaluatePolicyGate(completedResult, {
      repository: "acme/web",
      repositoryAllowlist: ["acme/web"],
      protectedPathDenylist: ["package.json", "infra/**"],
      expectedTargetBranch: "main",
    });

    expect(gate.allowed).toBe(true);
    expect(gate.artifact).toMatchObject({
      status: "passed",
      repositoryAllowed: true,
      deniedFiles: [],
    });
  });

  it("blocks non-allowlisted repositories and protected changed files", () => {
    const gate = evaluatePolicyGate(
      { ...completedResult, changedFiles: ["infra/prod.tf", "src/login.ts"] },
      {
        repository: "acme/admin",
        repositoryAllowlist: ["acme/web"],
        protectedPathDenylist: ["infra/**"],
        expectedTargetBranch: "main",
      },
    );

    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("Repository is not allowlisted");
    expect(gate.reason).toContain("infra/prod.tf");
    expect(gate.artifact).toMatchObject({
      status: "failed",
      repositoryAllowed: false,
      deniedFiles: ["infra/prod.tf"],
    });
  });

  it("blocks missing publish and verification evidence", () => {
    const gate = evaluatePolicyGate(
      {
        ...completedResult,
        targetBranch: "develop",
        commits: [],
        tests: [],
        pullRequestDraft: undefined,
      },
      {
        repository: "acme/web",
        repositoryAllowlist: ["acme/web"],
        protectedPathDenylist: [],
        expectedTargetBranch: "main",
      },
    );

    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("Target branch mismatch");
    expect(gate.reason).toContain("No local commit");
    expect(gate.reason).toContain("PR draft is missing");
    expect(gate.reason).toContain("Verification evidence is missing");
  });
});
