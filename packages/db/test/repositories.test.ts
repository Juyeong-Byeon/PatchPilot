import type { InternalPhase, UserOutcome } from "@ticket-to-pr/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type PgPool } from "../src/client.js";
import { migrate } from "../src/migrate.js";
import { Repositories } from "../src/repositories.js";

const connectionString = process.env.DATABASE_URL;

const baseTicket = {
  triggerVersion: "v1",
  title: "Fix login",
  description: "desc",
  definitionOfDone: "done",
  repository: "acme/web",
  targetBranch: "main",
  priority: "Normal" as const,
  status: "Progress",
  agentRunRequested: true,
  rawFields: {},
};

describe.skipIf(!connectionString)("Repositories", () => {
  let pool: PgPool;
  let repos: Repositories;

  beforeAll(async () => {
    await migrate(connectionString!);
    pool = createPool(connectionString!);
    repos = new Repositories(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function setPhase(jobId: string, phase: InternalPhase, outcome: UserOutcome): Promise<void> {
    await pool.query(`update jobs set phase=$2, outcome=$3, updated_at=now() where id=$1`, [jobId, phase, outcome]);
  }

  async function getPhase(jobId: string): Promise<{ phase: string; outcome: string }> {
    const row = await pool.query<{ phase: string; outcome: string }>(`select phase, outcome from jobs where id=$1`, [
      jobId,
    ]);
    return row.rows[0];
  }

  /** Seeds a job + run + (optional) pull request, returning the generated ids. */
  async function seedJob(suffix: string, withPr = false): Promise<{ jobId: string; runId: string; prNumber: number }> {
    const jobId = `job_${suffix}`;
    const runId = `run_${suffix}`;
    const prNumber = Number(suffix.replace(/\D/g, "").slice(-6)) || 1;
    await repos.createJobFromTicket(
      { ...baseTicket, larkRecordId: `rec_${suffix}` },
      { ticketSnapshotId: `ts_${suffix}`, jobId },
    );
    await repos.createRun({ id: runId, jobId, attempt: 1, workspacePath: "/tmp/ws", workBranch: "b" });
    if (withPr) {
      await repos.savePullRequest({
        id: `pr_${suffix}`,
        jobId,
        runId,
        repository: baseTicket.repository,
        targetBranch: "main",
        workBranch: "b",
        baseSha: "base",
        headSha: "head",
        commitShas: ["c1"],
        prUrl: `https://github.com/${baseTicket.repository}/pull/${prNumber}`,
        prNumber,
        prTitle: "PR",
        prBody: "body",
      });
    }
    return { jobId, runId, prNumber };
  }

  it("deduplicates jobs by lark record and trigger version", async () => {
    const suffix = `dedup_${Date.now()}`;
    const first = await repos.createJobFromTicket(
      { ...baseTicket, larkRecordId: `rec_${suffix}` },
      { ticketSnapshotId: `ts_${suffix}_1`, jobId: `job_${suffix}_1` },
    );
    const second = await repos.createJobFromTicket(
      { ...baseTicket, larkRecordId: `rec_${suffix}` },
      { ticketSnapshotId: `ts_${suffix}_2`, jobId: `job_${suffix}_2` },
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  describe("transitionJobGuarded — terminal invariant", () => {
    it("rejects transitioning out of a terminal phase (late event cannot overwrite Completed)", async () => {
      const { jobId } = await seedJob(`term_${Date.now()}`);
      await setPhase(jobId, "Completed", "Completed");
      const updated = await repos.transitionJobGuarded(jobId, "Failed", "FailedInternal");
      expect(updated).toBe(false);
      expect((await getPhase(jobId)).phase).toBe("Completed");
    });

    it("rejects when the row is not in the expected from-phase (optimistic guard)", async () => {
      const { jobId } = await seedJob(`exp_${Date.now()}`);
      await setPhase(jobId, "Implementing", "Running");
      // expectedFrom = Planning, but the row is Implementing -> no-op.
      const updated = await repos.transitionJobGuarded(jobId, "Reviewing", "Running", undefined, undefined, [
        "Planning",
      ]);
      expect(updated).toBe(false);
      expect((await getPhase(jobId)).phase).toBe("Implementing");
    });

    it("applies when the from-phase matches", async () => {
      const { jobId } = await seedJob(`ok_${Date.now()}`);
      await setPhase(jobId, "Publishing", "Running");
      const updated = await repos.transitionJobGuarded(jobId, "Completed", "NeedsReview", undefined, undefined, [
        "Publishing",
      ]);
      expect(updated).toBe(true);
      expect((await getPhase(jobId)).phase).toBe("Completed");
    });
  });

  describe("requestCancel — guarded against Publishing & terminal", () => {
    it("cancels a job that is mid-flight", async () => {
      const { jobId } = await seedJob(`can_${Date.now()}`);
      await setPhase(jobId, "Implementing", "Running");
      const result = await repos.requestCancel(jobId, "admin");
      expect(result.status).toBe("requested");
      expect((await getPhase(jobId)).phase).toBe("CancelRequested");
    });

    it("refuses to cancel during Publishing (the publish window is uncancelable)", async () => {
      const { jobId } = await seedJob(`pub_${Date.now()}`);
      await setPhase(jobId, "Publishing", "Running");
      const result = await repos.requestCancel(jobId, "admin");
      expect(result).toEqual({ status: "not_cancelable", phase: "Publishing" });
      expect((await getPhase(jobId)).phase).toBe("Publishing");
    });

    it("refuses to cancel a terminal job", async () => {
      const { jobId } = await seedJob(`cant_${Date.now()}`);
      await setPhase(jobId, "Completed", "Completed");
      const result = await repos.requestCancel(jobId, "admin");
      expect(result).toEqual({ status: "not_cancelable", phase: "Completed" });
    });

    it("reports not_found for an unknown job", async () => {
      const result = await repos.requestCancel(`job_missing_${Date.now()}`, "admin");
      expect(result).toEqual({ status: "not_found" });
    });
  });

  describe("markPullRequestMerged — terminal invariant & duplicate merge", () => {
    it("marks a NeedsReview job Completed on first merge", async () => {
      const { jobId, prNumber } = await seedJob(`merge_${Date.now()}`, true);
      await setPhase(jobId, "Completed", "NeedsReview");
      const result = await repos.markPullRequestMerged({ repository: baseTicket.repository, prNumber });
      expect(result.status).toBe("updated");
      expect((await getPhase(jobId)).outcome).toBe("Completed");
    });

    it("does not re-apply a duplicate / late merge once the job is terminal", async () => {
      const { jobId, prNumber } = await seedJob(`dupmerge_${Date.now()}`, true);
      await setPhase(jobId, "Completed", "NeedsReview");
      const first = await repos.markPullRequestMerged({ repository: baseTicket.repository, prNumber });
      expect(first.status).toBe("updated");
      // Replay: job is now Completed/Completed -> already_terminal, no second audit row.
      const auditBefore = await pool.query(
        `select count(*)::int as n from audit_events where job_id=$1 and action='pull_request.merged'`,
        [jobId],
      );
      const second = await repos.markPullRequestMerged({ repository: baseTicket.repository, prNumber });
      expect(second.status).toBe("already_terminal");
      const auditAfter = await pool.query(
        `select count(*)::int as n from audit_events where job_id=$1 and action='pull_request.merged'`,
        [jobId],
      );
      expect(auditAfter.rows[0].n).toBe(auditBefore.rows[0].n);
    });

    it("does not overwrite a Cancelled job with a late merge webhook", async () => {
      const { jobId, prNumber } = await seedJob(`latemerge_${Date.now()}`, true);
      await setPhase(jobId, "Cancelled", "Cancelled");
      const result = await repos.markPullRequestMerged({ repository: baseTicket.repository, prNumber });
      expect(result.status).toBe("already_terminal");
      expect(await getPhase(jobId)).toEqual({ phase: "Cancelled", outcome: "Cancelled" });
    });

    it("reports not_found for an untracked pull request", async () => {
      const result = await repos.markPullRequestMerged({ repository: "acme/web", prNumber: 9_999_999 });
      expect(result).toEqual({ status: "not_found" });
    });
  });

  describe("recordWebhookDelivery — exactly-once dedup", () => {
    it("returns true on first delivery and false on replay", async () => {
      const deliveryId = `dlv_${Date.now()}`;
      const first = await repos.recordWebhookDelivery({ deliveryId, provider: "github", payload: { a: 1 } });
      const replay = await repos.recordWebhookDelivery({ deliveryId, provider: "github", payload: { a: 1 } });
      expect(first).toBe(true);
      expect(replay).toBe(false);
    });
  });

  describe("listJobsAwaitingMergeReconcile", () => {
    it("returns NeedsReview jobs with an open PR and not jobs already merged/terminal", async () => {
      const stamp = Date.now();
      const pending = await seedJob(`recon_pending_${stamp}`, true);
      await setPhase(pending.jobId, "Completed", "NeedsReview");
      const merged = await seedJob(`recon_merged_${stamp}`, true);
      await setPhase(merged.jobId, "Completed", "Completed");

      const rows = await repos.listJobsAwaitingMergeReconcile();
      const ids = rows.map((r) => r.jobId);
      expect(ids).toContain(pending.jobId);
      expect(ids).not.toContain(merged.jobId);
      const row = rows.find((r) => r.jobId === pending.jobId);
      expect(row).toMatchObject({ repository: baseTicket.repository, prNumber: pending.prNumber });
    });
  });

  describe("createRetryAttempt with operator guidance (X4)", () => {
    async function failJob(jobId: string, outcome: UserOutcome): Promise<void> {
      await pool.query(
        `update jobs set phase='Failed', outcome=$2, failure_category='agent', updated_at=now() where id=$1`,
        [jobId, outcome],
      );
    }

    it("permits a FailedActionable retry only with guidance and persists it on the run", async () => {
      const { jobId } = await seedJob(`guid_actionable_${Date.now()}`);
      await failJob(jobId, "FailedActionable");

      // Without guidance, an actionable failure stays non-retryable.
      await expect(repos.createRetryAttempt(jobId, "admin")).rejects.toMatchObject({ statusCode: 409 });

      const retry = await repos.createRetryAttempt(jobId, "admin", { guidance: "Limit scope to auth.ts" });
      expect(retry.attempt).toBeGreaterThan(1);
      expect(await repos.getRunGuidance(retry.runId)).toBe("Limit scope to auth.ts");
      // The job is back to Queued for the worker to pick up.
      expect((await getPhase(jobId)).phase).toBe("Queued");
    });

    it("permits a FailedInternal retry with no guidance (guidance is null)", async () => {
      const { jobId } = await seedJob(`guid_internal_${Date.now()}`);
      await failJob(jobId, "FailedInternal");

      const retry = await repos.createRetryAttempt(jobId, "admin");
      expect(await repos.getRunGuidance(retry.runId)).toBeNull();
    });
  });

  describe("parkAwaitingInput + answerNeedsInput (NeedsInput)", () => {
    it("parks a running job at AwaitingInput/NeedsInput and persists the question", async () => {
      const { jobId } = await seedJob(`park_${Date.now()}`);
      await setPhase(jobId, "Implementing", "Running");
      const parked = await repos.parkAwaitingInput(jobId, "CSV or XLSX?", [
        "Queued",
        "Planning",
        "Implementing",
        "Reviewing",
        "Testing",
      ]);
      expect(parked).toBe(true);
      expect(await getPhase(jobId)).toEqual({ phase: "AwaitingInput", outcome: "NeedsInput" });
      const row = await pool.query<{ pending_question: string }>(`select pending_question from jobs where id=$1`, [
        jobId,
      ]);
      expect(row.rows[0].pending_question).toBe("CSV or XLSX?");
    });

    it("does not park a terminal job (guard rejects, question untouched)", async () => {
      const { jobId } = await seedJob(`parkterm_${Date.now()}`);
      await setPhase(jobId, "Completed", "Completed");
      const parked = await repos.parkAwaitingInput(jobId, "too late?", ["Implementing"]);
      expect(parked).toBe(false);
      expect((await getPhase(jobId)).phase).toBe("Completed");
    });

    it("answers a parked job: persists the answer as run guidance, clears the question, re-queues", async () => {
      const { jobId } = await seedJob(`answer_${Date.now()}`);
      await setPhase(jobId, "Implementing", "Running");
      await repos.parkAwaitingInput(jobId, "Which API version?", ["Implementing"]);

      const result = await repos.answerNeedsInput(jobId, "Use v2.", "admin");
      expect(result.attempt).toBeGreaterThan(1);
      // Answer IS guidance — reuses the retry-with-guidance plumbing.
      expect(await repos.getRunGuidance(result.runId)).toBe("Use v2.");
      // Job re-queued and the pending question cleared.
      expect((await getPhase(jobId)).phase).toBe("Queued");
      const row = await pool.query<{ pending_question: string | null }>(
        `select pending_question from jobs where id=$1`,
        [jobId],
      );
      expect(row.rows[0].pending_question).toBeNull();
      // Audit row records the answer (without text).
      const audit = await pool.query<{ n: number }>(
        `select count(*)::int as n from audit_events where job_id=$1 and action='job.answer_submitted'`,
        [jobId],
      );
      expect(audit.rows[0].n).toBe(1);
    });

    it("rejects answering a job that is not awaiting input (409) and a re-park double-submit", async () => {
      const { jobId } = await seedJob(`answerguard_${Date.now()}`);
      await setPhase(jobId, "Implementing", "Running");
      await repos.parkAwaitingInput(jobId, "q?", ["Implementing"]);

      // First answer resumes the job.
      await repos.answerNeedsInput(jobId, "first answer", "admin");
      // Second answer (the job is now Queued, not parked) must 409 — re-park is impossible.
      await expect(repos.answerNeedsInput(jobId, "second answer", "admin")).rejects.toMatchObject({ statusCode: 409 });
    });

    it("rejects an empty answer (409)", async () => {
      const { jobId } = await seedJob(`answerempty_${Date.now()}`);
      await setPhase(jobId, "Implementing", "Running");
      await repos.parkAwaitingInput(jobId, "q?", ["Implementing"]);
      await expect(repos.answerNeedsInput(jobId, "   ", "admin")).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe("getMetrics (X5)", () => {
    it("aggregates success/failure/merge/retry/mode over the window", async () => {
      const stamp = `metrics_${Date.now()}`;
      // A NeedsReview job with a single-pass run.
      const review = await seedJob(`${stamp}_review`, true);
      await pool.query(`update runs set executor_mode='single-pass' where job_id=$1`, [review.jobId]);
      await setPhase(review.jobId, "Completed", "NeedsReview");
      await pool.query(
        `insert into run_events(job_id, run_id, phase, event_type, source, message)
         values ($1,$2,'Completed','worker.completed','worker','reached review')`,
        [review.jobId, review.runId],
      );
      // A merged job (staged).
      const merged = await seedJob(`${stamp}_merged`, true);
      await pool.query(`update runs set executor_mode='staged' where job_id=$1`, [merged.jobId]);
      await setPhase(merged.jobId, "Completed", "Completed");
      // A policy-failed job.
      const failed = await seedJob(`${stamp}_failed`);
      await pool.query(
        `update jobs set phase='Failed', outcome='FailedActionable', failure_category='policy' where id=$1`,
        [failed.jobId],
      );

      const metrics = await repos.getMetrics();
      expect(metrics.totalJobs).toBeGreaterThanOrEqual(3);
      expect(metrics.needsReviewJobs).toBeGreaterThanOrEqual(2); // review + merged
      expect(metrics.mergedJobs).toBeGreaterThanOrEqual(1);
      expect(metrics.failureBreakdown.policy).toBeGreaterThanOrEqual(1);
      expect(metrics.executorModeDistribution.singlePass).toBeGreaterThanOrEqual(1);
      expect(metrics.executorModeDistribution.staged).toBeGreaterThanOrEqual(1);
      expect(metrics.successRate).toBeGreaterThan(0);
      expect(metrics.mergeRate).toBeGreaterThan(0);
      // The review job has a Completed run_event after created_at → measurable runtime.
      expect(metrics.runtimeSeconds.sampleSize).toBeGreaterThanOrEqual(1);
    });

    it("scopes to the ?days window", async () => {
      // A 0-row-window sanity check: a 1-day window over freshly created jobs
      // still includes them, and the shape is well-formed.
      const metrics = await repos.getMetrics(1);
      expect(metrics.periodDays).toBe(1);
      expect(metrics.totalJobs).toBeGreaterThanOrEqual(0);
      expect(metrics.failureBreakdown.total).toBe(
        metrics.failureBreakdown.policy +
          metrics.failureBreakdown.agent +
          metrics.failureBreakdown.publish +
          metrics.failureBreakdown.infra +
          metrics.failureBreakdown.uncategorized,
      );
    });
  });
});
