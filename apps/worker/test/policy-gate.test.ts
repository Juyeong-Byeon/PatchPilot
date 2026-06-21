import { describe, expect, it } from "vitest";
import { evaluatePolicyGate, evaluatePreExecutionPolicy, isValidBranchName } from "../src/policy-gate.js";

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

  it("blocks missing publish evidence but treats absent tests as skipped, not blocking", () => {
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
    // N2: no tests at all is honest "no verification" → skipped, NOT a hard fail.
    expect(gate.reason).not.toContain("Verification");
    expect(gate.artifact.verification).toBe("skipped");
  });

  it("accepts a skipped single-pass test as truthful 'no verification ran'", () => {
    const gate = evaluatePolicyGate(
      {
        ...completedResult,
        tests: [{ command: "project verification", status: "skipped", summary: "no verification" }],
      },
      {
        repository: "acme/web",
        repositoryAllowlist: ["acme/web"],
        protectedPathDenylist: [],
        expectedTargetBranch: "main",
      },
    );

    expect(gate.allowed).toBe(true);
    expect(gate.artifact.verification).toBe("skipped");
  });

  it("blocks an explicit verification failure", () => {
    const gate = evaluatePolicyGate(
      {
        ...completedResult,
        tests: [{ command: "npm test", status: "failed", summary: "2 specs failed" }],
      },
      {
        repository: "acme/web",
        repositoryAllowlist: ["acme/web"],
        protectedPathDenylist: [],
        expectedTargetBranch: "main",
      },
    );

    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("Verification failed");
    expect(gate.artifact.verification).toBe("failed");
  });

  it("blocks when the diff evidence contains a secret (X7 secret scan)", () => {
    const gate = evaluatePolicyGate(
      {
        ...completedResult,
        commits: [{ sha: "abc", message: "add key AKIAIOSFODNN7EXAMPLE" }],
      },
      {
        repository: "acme/web",
        repositoryAllowlist: ["acme/web"],
        protectedPathDenylist: [],
        expectedTargetBranch: "main",
      },
    );

    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("Potential secrets detected");
    expect(gate.artifact.secretFindings?.[0]?.rule).toBe("aws-access-key-id");
  });

  it("passes a clean diff with empty secretFindings", () => {
    const gate = evaluatePolicyGate(completedResult, {
      repository: "acme/web",
      repositoryAllowlist: ["acme/web"],
      protectedPathDenylist: [],
      expectedTargetBranch: "main",
    });
    expect(gate.allowed).toBe(true);
    expect(gate.artifact.secretFindings).toEqual([]);
  });
});

describe("isValidBranchName", () => {
  it("accepts normal branch names", () => {
    for (const branch of ["main", "develop", "feature/login", "release-1.2.3", "fix/JIRA-42_thing"]) {
      expect(isValidBranchName(branch)).toBe(true);
    }
  });

  it("rejects malformed branch names", () => {
    for (const branch of [
      "",
      " main",
      "main ",
      "/main",
      "main/",
      "feat//x",
      ".hidden",
      "trailing.",
      "a..b",
      "ref.lock",
      "has space",
      "has~tilde",
      "has^caret",
      "has:colon",
      "star*",
      "q?mark",
      "br[acket",
      "back\\slash",
      "ref@{0}",
    ]) {
      expect(isValidBranchName(branch)).toBe(false);
    }
  });
});

describe("evaluatePreExecutionPolicy (X7 strengthening)", () => {
  const base = {
    repository: "acme/web",
    repositoryAllowlist: ["acme/web"],
    protectedPathDenylist: ["infra/**"],
  };

  it("passes an allowlisted repo with a valid target branch", () => {
    const gate = evaluatePreExecutionPolicy({ ...base, expectedTargetBranch: "main" });
    expect(gate.allowed).toBe(true);
  });

  it("blocks a non-allowlisted repository up front", () => {
    const gate = evaluatePreExecutionPolicy({ ...base, repository: "evil/web", expectedTargetBranch: "main" });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("not allowlisted");
  });

  it("blocks a malformed target branch before the agent runs", () => {
    const gate = evaluatePreExecutionPolicy({ ...base, expectedTargetBranch: "bad branch~name" });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("Invalid target branch name");
  });

  it("blocks a target branch that matches the protected-path denylist", () => {
    const gate = evaluatePreExecutionPolicy({
      ...base,
      protectedPathDenylist: ["main"],
      expectedTargetBranch: "main",
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("Target branch is protected");
  });
});
