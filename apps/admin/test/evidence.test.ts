import { describe, expect, it } from "vitest";
import {
  extractJobEvidence,
  normalizeExecutorMode,
  parseDefinitionOfDone,
  readExecutorMode,
} from "../src/lib/evidence.js";
import { resolvePrimaryStatus, matchesStatusFilter, isNeedsReviewJob } from "../src/lib/status.js";

describe("extractJobEvidence", () => {
  it("returns present=false when no policy/result artifacts exist", () => {
    const evidence = extractJobEvidence([{ id: "a", kind: "gstack-plan", content: "# plan" }]);
    expect(evidence.present).toBe(false);
    expect(evidence.changedFileCount).toBe(0);
    expect(evidence.verification).toBe("none");
  });

  it("flags protected-path violations from the policy gate", () => {
    const evidence = extractJobEvidence([
      {
        id: "p",
        kind: "policy-gate",
        content: {
          status: "failed",
          changedFiles: [".github/workflows/ci.yml"],
          deniedFiles: [".github/workflows/ci.yml"],
          reasons: ["Protected files changed"],
        },
      },
    ]);
    expect(evidence.present).toBe(true);
    expect(evidence.deniedFiles).toEqual([".github/workflows/ci.yml"]);
    expect(evidence.policyStatus).toBe("failed");
  });

  it("classifies skipped-only tests as 'skipped' verification, never passed", () => {
    const evidence = extractJobEvidence([
      {
        id: "r",
        kind: "agent-result",
        content: {
          status: "completed",
          tests: [{ command: "git diff --name-only", status: "skipped", summary: "no tests" }],
        },
      },
    ]);
    expect(evidence.verification).toBe("skipped");
  });

  it("classifies a passing test run as 'passed' and surfaces audited SHAs", () => {
    const evidence = extractJobEvidence([
      {
        id: "r",
        kind: "agent-result",
        content: {
          status: "completed",
          baseSha: "7092a07000000000000000000000000000000000",
          headSha: "9a067b6000000000000000000000000000000000",
          targetBranch: "main",
          changedFiles: ["src/a.ts"],
          tests: [{ command: "npm run ci", status: "passed", summary: "all green" }],
        },
      },
    ]);
    expect(evidence.verification).toBe("passed");
    expect(evidence.baseSha).toMatch(/^7092a07/);
    expect(evidence.headSha).toMatch(/^9a067b6/);
    expect(evidence.targetBranch).toBe("main");
    expect(evidence.changedFileCount).toBe(1);
  });
});

describe("parseDefinitionOfDone", () => {
  it("splits markdown bullets into checklist items", () => {
    expect(parseDefinitionOfDone("- one\n- two\n- three")).toEqual(["one", "two", "three"]);
  });

  it("splits numbered lists", () => {
    expect(parseDefinitionOfDone("1. first\n2. second")).toEqual(["first", "second"]);
  });

  it("splits plain multi-line text one criterion per line", () => {
    expect(parseDefinitionOfDone("does a thing\ndoes another")).toEqual(["does a thing", "does another"]);
  });

  it("keeps a single free-form paragraph as prose (empty checklist)", () => {
    expect(parseDefinitionOfDone("just one sentence describing done")).toEqual([]);
  });

  it("returns empty for non-strings", () => {
    expect(parseDefinitionOfDone(null)).toEqual([]);
    expect(parseDefinitionOfDone(undefined)).toEqual([]);
  });
});

describe("readExecutorMode / normalizeExecutorMode", () => {
  it("reads snake_case and camelCase fields, returns null when absent", () => {
    expect(readExecutorMode({ id: "j" })).toBeNull();
    expect(readExecutorMode({ id: "j", executor_mode: "staged" })).toBe("staged");
    expect(readExecutorMode({ id: "j", executorMode: "single-pass" })).toBe("single-pass");
    expect(readExecutorMode(null)).toBeNull();
  });

  it("normalizes known synonyms", () => {
    expect(normalizeExecutorMode("gstack")).toBe("staged");
    expect(normalizeExecutorMode("codex")).toBe("single-pass");
    expect(normalizeExecutorMode("single")).toBe("single-pass");
    expect(normalizeExecutorMode("something-new")).toBe("other");
  });
});

describe("resolvePrimaryStatus (state SSoT)", () => {
  it("collapses Completed+NeedsReview to a single NeedsReview state", () => {
    expect(resolvePrimaryStatus({ phase: "Completed", outcome: "NeedsReview" })).toBe("NeedsReview");
  });

  it("collapses both in-flight cancel phases to Cancelling", () => {
    expect(resolvePrimaryStatus({ phase: "CancelRequested", outcome: "Running" })).toBe("Cancelling");
    expect(resolvePrimaryStatus({ phase: "Cancelling", outcome: "Running" })).toBe("Cancelling");
  });

  it("prefers a terminal failure outcome over the phase", () => {
    expect(resolvePrimaryStatus({ phase: "Failed", outcome: "FailedInternal" })).toBe("FailedInternal");
  });

  it("falls back to the running phase when outcome is Running", () => {
    expect(resolvePrimaryStatus({ phase: "Implementing", outcome: "Running" })).toBe("Implementing");
  });
});

describe("needsReview filter mutual exclusivity", () => {
  const reviewJob = { phase: "Completed", outcome: "NeedsReview" };
  it("matches the needsReview filter but not the completed filter", () => {
    expect(isNeedsReviewJob(reviewJob.phase, reviewJob.outcome)).toBe(true);
    expect(matchesStatusFilter(reviewJob, "needsReview")).toBe(true);
    expect(matchesStatusFilter(reviewJob, "completed")).toBe(false);
  });
});
