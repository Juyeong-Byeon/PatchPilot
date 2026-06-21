import { describe, expect, it } from "vitest";
import {
  isCompletedJob,
  isFailedJob,
  isNeedsReviewJob,
  isRunningPhase,
  matchesStatusFilter,
} from "../src/lib/status.js";

// These tests pin the CURRENT behavior of the pure status guards in
// apps/admin/src/lib/status.ts. Each assertion is derived from the source, not
// from the intended spec — where the two diverge (see CancelFailed below) the
// test documents what the code actually does today.

describe("isRunningPhase", () => {
  // RUNNING_PHASES = ["Queued", "Planning", "Implementing", "PolicyChecking", "Publishing"]
  // matched via RUNNING_PHASES.includes(String(phase)).
  it("is true for every phase in the running set", () => {
    expect(isRunningPhase("Queued")).toBe(true);
    expect(isRunningPhase("Planning")).toBe(true);
    expect(isRunningPhase("Implementing")).toBe(true);
    expect(isRunningPhase("PolicyChecking")).toBe(true);
    expect(isRunningPhase("Publishing")).toBe(true);
  });

  it("is false for parked, terminal, and absent phases", () => {
    expect(isRunningPhase("AwaitingInput")).toBe(false);
    expect(isRunningPhase("Completed")).toBe(false);
    expect(isRunningPhase("Failed")).toBe(false);
    expect(isRunningPhase("NeedsReview")).toBe(false);
    expect(isRunningPhase("Cancelled")).toBe(false);
    expect(isRunningPhase(undefined)).toBe(false);
    expect(isRunningPhase(null)).toBe(false);
    expect(isRunningPhase("")).toBe(false);
  });

  it("is case-sensitive and exact (no partial / lowercase matches)", () => {
    expect(isRunningPhase("queued")).toBe(false);
    expect(isRunningPhase("Implementing ")).toBe(false);
  });
});

describe("isFailedJob", () => {
  // String(phase).startsWith("Failed") || String(outcome).startsWith("Failed")
  it("is true when the PHASE starts with Failed", () => {
    expect(isFailedJob("FailedInternal", "Running")).toBe(true);
    expect(isFailedJob("FailedActionable", "Running")).toBe(true);
    // "Failed" alone (a bare failed phase) also matches.
    expect(isFailedJob("Failed", "Running")).toBe(true);
  });

  it("is true when the OUTCOME starts with Failed", () => {
    expect(isFailedJob("Implementing", "FailedInternal")).toBe(true);
    expect(isFailedJob("Implementing", "FailedActionable")).toBe(true);
  });

  it("is false for cancelled / needs-review / completed states", () => {
    expect(isFailedJob("Cancelled", "Cancelled")).toBe(false);
    expect(isFailedJob("Completed", "NeedsReview")).toBe(false);
    expect(isFailedJob("Completed", "Completed")).toBe(false);
    expect(isFailedJob("AwaitingInput", "NeedsInput")).toBe(false);
  });

  it("does NOT treat CancelFailed as failed (it does not start with 'Failed')", () => {
    // The guard keys on the prefix "Failed"; "CancelFailed" starts with "Cancel",
    // so the current code classifies it as NOT failed via this guard. Pinning the
    // real behavior (the spec comment claiming CancelFailed is a failure does not
    // hold for isFailedJob).
    expect(isFailedJob("CancelFailed", "Running")).toBe(false);
    expect(isFailedJob("Implementing", "CancelFailed")).toBe(false);
  });

  it("is false when neither phase nor outcome is present", () => {
    expect(isFailedJob(undefined, undefined)).toBe(false);
    expect(isFailedJob(null, null)).toBe(false);
  });
});

describe("isCompletedJob", () => {
  // phase === "Completed" || outcome === "Completed" (strict, no String coercion).
  it("is true when the phase is Completed", () => {
    expect(isCompletedJob("Completed", "Running")).toBe(true);
    expect(isCompletedJob("Completed", undefined)).toBe(true);
  });

  it("is true when the outcome is Completed", () => {
    expect(isCompletedJob("Publishing", "Completed")).toBe(true);
    expect(isCompletedJob(undefined, "Completed")).toBe(true);
  });

  it("is false for non-completed phase/outcome pairs", () => {
    expect(isCompletedJob("Implementing", "Running")).toBe(false);
    expect(isCompletedJob("Failed", "FailedInternal")).toBe(false);
    expect(isCompletedJob("Cancelled", "Cancelled")).toBe(false);
    expect(isCompletedJob(undefined, undefined)).toBe(false);
    expect(isCompletedJob(null, null)).toBe(false);
  });

  it("uses strict equality, so 'Completed' substrings do not match", () => {
    expect(isCompletedJob("CompletedSoon", "Running")).toBe(false);
  });

  it("STILL reports completed for phase=Completed + outcome=NeedsReview (guard does not exclude review)", () => {
    // isCompletedJob itself does NOT subtract NeedsReview; the exclusion lives in
    // matchesStatusFilter("completed"). This pins that division of responsibility.
    expect(isCompletedJob("Completed", "NeedsReview")).toBe(true);
    expect(isNeedsReviewJob("Completed", "NeedsReview")).toBe(true);
  });
});

describe("isNeedsReviewJob ↔ completed mutual exclusion", () => {
  // matchesStatusFilter("completed") = isCompletedJob(...) && !isNeedsReviewJob(...)
  it("excludes a Completed+NeedsReview job from the 'completed' filter", () => {
    const job = { phase: "Completed", outcome: "NeedsReview" };
    // Both guards fire individually...
    expect(isCompletedJob(job.phase, job.outcome)).toBe(true);
    expect(isNeedsReviewJob(job.phase, job.outcome)).toBe(true);
    // ...but the composite "completed" filter subtracts review-parked jobs.
    expect(matchesStatusFilter(job, "completed")).toBe(false);
    expect(matchesStatusFilter(job, "needsReview")).toBe(true);
  });

  it("keeps a sealed Completed job (no NeedsReview) in the 'completed' filter", () => {
    const job = { phase: "Completed", outcome: "Completed" };
    expect(matchesStatusFilter(job, "completed")).toBe(true);
    expect(matchesStatusFilter(job, "needsReview")).toBe(false);
  });

  it("keeps the 'failed' and 'completed' filters mutually exclusive from a clean park", () => {
    const parked = { phase: "AwaitingInput", outcome: "NeedsInput" };
    expect(matchesStatusFilter(parked, "failed")).toBe(false);
    expect(matchesStatusFilter(parked, "completed")).toBe(false);
  });
});
