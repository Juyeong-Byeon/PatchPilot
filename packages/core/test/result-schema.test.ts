import { describe, expect, it } from "vitest";
import { parseAgentResult } from "../src/result-schema.js";

describe("parseAgentResult", () => {
  it("accepts completed result with PR draft", () => {
    const result = parseAgentResult({
      schemaVersion: "1.0",
      runId: "run_1",
      jobId: "job_1",
      ticketId: "rec1",
      triggerVersion: "v1",
      status: "completed",
      targetBranch: "main",
      baseSha: "abc",
      headSha: "def",
      pushSha: "0123456789abcdef0123456789abcdef01234567",
      changedFiles: ["src/app.ts"],
      commits: [{ sha: "def", message: "Fix login" }],
      tests: [{ command: "npm test", status: "passed", summary: "ok" }],
      review: { summary: "reviewed", risks: [], knownLimitations: [] },
      pullRequestDraft: { title: "Fix login", bodyPath: "output/pr-body.md" },
      failure: null,
      retryable: false
    });
    expect(result.status).toBe("completed");
  });

  it("rejects failed results without failure details", () => {
    expect(() =>
      parseAgentResult({
        schemaVersion: "1.0",
        runId: "run_1",
        jobId: "job_1",
        ticketId: "rec1",
        triggerVersion: "v1",
        status: "failed",
        failure: null,
        retryable: true
      })
    ).toThrow();
  });

  it("rejects completed results without local evidence and PR draft", () => {
    expect(() =>
      parseAgentResult({
        schemaVersion: "1.0",
        runId: "run_1",
        jobId: "job_1",
        ticketId: "rec1",
        triggerVersion: "v1",
        status: "completed",
        changedFiles: [],
        commits: [],
        tests: [],
        failure: null,
        retryable: false
      })
    ).toThrow();
  });

  it("rejects completed results without a full audited push SHA", () => {
    const completed = {
      schemaVersion: "1.0",
      runId: "run_1",
      jobId: "job_1",
      ticketId: "rec1",
      triggerVersion: "v1",
      status: "completed",
      targetBranch: "main",
      baseSha: "abc",
      headSha: "def",
      changedFiles: ["src/app.ts"],
      commits: [{ sha: "def", message: "Fix login" }],
      tests: [{ command: "npm test", status: "passed", summary: "ok" }],
      review: { summary: "reviewed", risks: [], knownLimitations: [] },
      pullRequestDraft: { title: "Fix login", bodyPath: "output/pr-body.md" },
      failure: null,
      retryable: false
    };

    expect(() => parseAgentResult(completed)).toThrow();
    expect(() => parseAgentResult({ ...completed, pushSha: "short" })).toThrow();
  });
});
