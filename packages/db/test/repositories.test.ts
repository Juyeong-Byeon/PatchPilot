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
});
