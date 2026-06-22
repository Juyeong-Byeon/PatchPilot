# AI Ticket-to-PR Agent Platform Design

Date: 2026-06-19
Status: Draft for user review

## 1. Summary

AI Ticket-to-PR Agent Platform is an end-to-end MVP that turns a Lark Base ticket into a human-reviewable GitHub pull request.

The MVP runs on a single server or personal computer through Docker Compose. Lark Base triggers work, the platform creates a queued job, a self-hosted worker launches an isolated runner container, gstack/Claude edits and commits code locally, and the platform validates, pushes, and opens the pull request.

The important ownership boundary is:

- The agent may modify code, run review/test steps, create local commits, and draft PR title/body.
- The platform owns repository allowlist checks, branch publishing, policy gates, remote push, and PR creation.
- Humans own final review, merge, deploy, and release decisions.

## 2. Goals

- Accept work from Lark Base when a ticket is explicitly requested for agent execution.
- Run each job in an isolated container from a fixed runner image.
- Use gstack as the agent workflow executor for plan, implementation, review, tests, and local commit creation.
- Keep state, logs, artifacts, and outcomes durable in Postgres.
- Use Redis/BullMQ for asynchronous delivery and worker coordination.
- Create a GitHub PR only after platform-owned policy gates pass.
- Provide an Admin UI for job status, run timeline, logs, artifacts, PR links, retry, and cancel.
- Make the project easy to run with `docker compose up`.

## 3. Non-Goals

- Automatic merge.
- Automatic deploy.
- Production database changes.
- Infrastructure changes.
- Secret changes.
- Automatic permission policy changes.
- GitHub App authentication in MVP. The MVP uses a fine-grained, repo-scoped GitHub Personal Access Token and keeps GitHub App as the V2 migration path.
- Jira, GitHub Issue, Slack, multi-agent workflows, AI reviewer agent, AI QA agent, release notes, and sprint reports.

## 4. Target Users

Primary users:

- Developers who write tickets, request AI execution, and review generated PRs.
- PMs or planners who write requirements and check progress.

MVP operator:

- A developer or technical owner who installs the Docker Compose package, configures credentials, monitors runs, and handles failures.

## 5. System Architecture

Services:

- `api`: Lark webhook receiver, REST API, Admin UI server, health endpoints.
- `worker`: BullMQ consumer that manages runner lifecycle and state transitions.
- `postgres`: source of truth for tickets, jobs, runs, events, logs, artifacts, and PR metadata.
- `redis`: BullMQ queue and delivery coordination.
- `runner image`: fixed Docker image used for each job container.

Primary flow:

1. User updates a Lark Base ticket.
2. Lark sends a webhook to `POST /webhooks/lark`.
3. API validates the event and trigger conditions.
4. API stores a ticket snapshot and job in Postgres.
5. API enqueues the job in BullMQ.
6. Worker claims the job and creates a run attempt.
7. Worker creates a per-job workspace and starts a runner container.
8. Runner clones the repository, checks out the target branch, creates a work branch, writes input files, and invokes gstack.
9. gstack/Claude modifies code, reviews, tests, creates local commit(s), and writes result artifacts.
10. Worker reads the result, validates schema, inspects git diff/commits, and runs policy gates.
11. Platform pushes the work branch and creates the PR using the agent-drafted title/body plus platform metadata.
12. API/Admin UI/Lark receive the final outcome.

## 6. Lark Base Contract

Required ticket fields:

- `Title`
- `Description`
- `Definition of Done`
- `Repository`
- `Target Branch`
- `Priority`
- `Status`
- `Agent Run Requested`

Optional ticket input fields:

- `Staged Pipeline` - boolean. When true, the worker uses the staged pipeline for
  that ticket. `Priority=High` remains priority only and does not imply staged
  execution.

Optional platform-managed fields:

- `Last Agent Run ID`
- `Last Trigger Version`
- `Run Requested At`
- `Agent Status`
- `Agent PR URL`
- `Agent Failure Reason`
- `Agent Next Action`

Trigger rule:

- Create a job only when `Status = Progress` and `Agent Run Requested = true`.
- If either condition is false, store or ignore the webhook according to audit settings, but do not enqueue work.

Target branch rule:

- `Target Branch` is both the checkout base branch and the PR target branch.
- Empty, malformed, denied, or missing branches fail validation before runner execution.

Rerun rule:

- A record can rerun only when the trigger version changes or `Agent Run Requested` is toggled false then true.
- Admin retry creates a new run attempt and records the actor in audit logs.

## 7. Domain Model

### TicketSnapshot

Immutable snapshot of the Lark ticket at execution time.

Fields include:

- Lark record id
- Title
- Description
- Definition of Done
- Repository
- Target Branch
- Priority
- Trigger version
- Raw field snapshot

### Job

One execution request for a ticket snapshot.

Fields include:

- Job id
- Ticket snapshot id
- Idempotency key: `(lark_record_id, trigger_version)`
- User-facing outcome
- Current internal phase
- Priority
- Failure category
- Failure reason
- Next action
- Created and updated timestamps

Constraints:

- Unique `(lark_record_id, trigger_version)`.
- At most one active job per Lark record.

### Run

One concrete worker/runner attempt for a job.

Fields include:

- Run id
- Job id
- Attempt number
- Container id
- Runner image digest
- Workspace path
- Base SHA
- Work branch
- Head SHA
- Exit code
- Heartbeat timestamp
- Start and finish timestamps

### RunEvent

Structured, append-only event stream for state transitions and important operations.

Fields include:

- Job id
- Run id
- Attempt
- Phase
- Event type
- Message
- Source
- Metadata JSON
- Timestamp

### JobLog

Masked log lines from API, worker, runner, gstack, Docker, and GitHub operations.

Fields include:

- Job id
- Run id
- Source
- Stream
- Sequence
- Redaction applied flag
- Text
- Timestamp

### Artifact

Durable snapshots needed for audit and debugging.

Examples:

- `ticket.md`
- `context.json`
- `policy.json`
- `result.json`
- PR title/body draft
- Test summary
- Policy gate report
- Changed files

### PullRequestResult

PR metadata created by the platform.

Fields include:

- Repository
- Target branch
- Work branch
- Base SHA
- Head SHA
- Commit SHA list
- PR URL
- PR number
- PR title
- PR body

## 8. State Model

Postgres is the source of truth for job and run state. BullMQ is a delivery mechanism only.

All state transitions are written through database transactions with attempt/version checks. BullMQ retries must not directly define final job state.

Internal phases:

- `Queued`
- `Planning`
- `Implementing`
- `Reviewing`
- `Testing`
- `PolicyChecking`
- `Publishing`
- `Completed`
- `Failed`
- `CancelRequested`
- `Cancelling`
- `Cancelled`
- `CancelFailed`

User-facing outcomes:

- `Queued`: waiting for worker capacity.
- `Running`: currently executing.
- `NeedsReview`: terminal MVP success. PR was created and is ready for human review.
- `FailedActionable`: user or operator can fix input/config and retry.
- `FailedInternal`: platform, runner, or unexpected error requiring operator investigation.
- `Cancelled`: user or operator cancellation completed.

`Completed` remains an internal terminal phase and a compatibility label for the original queue model. The Admin UI and Lark-facing result should present successful MVP runs as `NeedsReview` because merge and deploy are human decisions.

Completion condition:

- Local commit exists.
- `result.json` is valid.
- PR title and body draft exist.
- Verification evidence exists.
- Policy gate passes.
- Platform push succeeds.
- Platform PR creation succeeds.

## 9. Idempotency, Retry, and Cancel

Idempotency:

- Lark webhook dedupe uses `(lark_record_id, trigger_version)`.
- Job creation uses a database unique constraint.
- Active job protection prevents concurrent execution for the same Lark record.
- Worker execution uses `run_id + attempt + trigger_version`.
- Branch and PR reconciliation uses repository, work branch, and run id metadata.

Retry:

- Retry always creates a new run attempt.
- Failed workspaces are preserved according to retention settings.
- The retry preflight checks existing workspace, branch, commits, and PR metadata.
- If an existing PR is detected for the same job, the operator sees it before retry proceeds.

Cancel:

- Cancel creates a durable cancel request.
- Worker stops queued BullMQ delivery or stops/kills the runner container.
- Runner checks cancel state between major phases when possible.
- After publishing starts, cancel is best-effort. Existing pushed commits or created PRs are not automatically deleted or closed in MVP.
- UI exposes `Cancel requested`, `Cancelling`, `Cancelled`, and `Cancel failed`.

## 10. Runner and gstack Contract

Workspace layout:

```text
/work/jobs/<job-id>/
  input/
    ticket.md
    context.json
    policy.json
  repo/
  output/
    result.json
    pr-title.txt
    pr-body.md
    review.md
    test-results/
    policy-notes.md
  logs/
    runner.log
    gstack.log
  secrets/
    runtime.env
```

Runner responsibilities:

- Clone the allowlisted repository.
- Checkout `Target Branch`.
- Record `base_sha`.
- Create the work branch `agent/<ticket-id>-<slug>`, appending a short suffix if required.
- Write input files.
- Invoke gstack.
- Capture stdout/stderr.
- Enforce timeout.
- Verify that local commit(s) exist before returning success.
- Never push to remote.
- Never create a PR.

gstack/Claude responsibilities:

- Read `ticket.md`, `context.json`, and `policy.json`.
- Analyze requirements and plan changes.
- Modify code.
- Run self-review.
- Run available tests, lint, type checks, or build commands.
- Create local git commit(s).
- Write `result.json`.
- Write PR title draft.
- Write PR body draft.
- Write test evidence and risk notes.

gstack/Claude restrictions:

- No remote push.
- No PR creation.
- No merge.
- No deploy.
- No secret modification.
- No infrastructure modification.
- No production database modification.
- No access to GitHub PAT unless required for read-only operations and explicitly allowed by runner policy.

## 11. Result Schema

`output/result.json` must include:

```json
{
  "schemaVersion": "1.0",
  "runId": "run_123",
  "jobId": "job_123",
  "ticketId": "lark_record_id",
  "triggerVersion": "version",
  "status": "completed",
  "targetBranch": "main",
  "baseSha": "abc123",
  "headSha": "def456",
  "changedFiles": ["src/example.ts"],
  "commits": [
    {
      "sha": "def456",
      "message": "Implement ticket change"
    }
  ],
  "tests": [
    {
      "command": "npm test",
      "status": "passed",
      "summary": "All tests passed"
    }
  ],
  "review": {
    "summary": "Self-review completed",
    "risks": [],
    "knownLimitations": []
  },
  "pullRequestDraft": {
    "title": "Implement ticket change",
    "bodyPath": "output/pr-body.md"
  },
  "failure": null,
  "retryable": false
}
```

Failure shape:

```json
{
  "schemaVersion": "1.0",
  "runId": "run_123",
  "jobId": "job_123",
  "status": "failed",
  "failure": {
    "stage": "Testing",
    "category": "verification_failed",
    "message": "Unit tests failed",
    "retryable": true,
    "nextAction": "Inspect test output and retry after fixing ticket or repo state"
  }
}
```

The platform validates this schema before publishing.

## 12. Platform Policy Gate

The platform runs policy checks after gstack returns and before remote push.

Required MVP checks:

- Repository is allowlisted.
- Target branch matches ticket snapshot.
- Work branch name matches platform-generated branch.
- Local commit exists on top of recorded base SHA.
- `result.json` schema is valid.
- PR title/body draft exists.
- Changed file list matches `git diff --name-only base_sha..HEAD`.
- Protected path denylist passes.
- Secret scan passes.
- Token masking has been applied to logs.
- Verification evidence exists.
- No remote push occurred inside runner.

If any required gate fails, the job becomes `FailedActionable` or `FailedInternal` based on the failure category. The platform does not push or create a PR.

## 13. GitHub Publishing

GitHub authentication:

- MVP uses a fine-grained, repo-scoped GitHub PAT.
- PAT is injected only into the platform publisher, not stored in DB.
- PAT is not written to workspace files.
- Logs are masked before persistence.

Publishing steps:

1. Confirm policy gate passed.
2. Push platform-generated work branch.
3. Create PR targeting the ticket `Target Branch`.
4. Use gstack-drafted title and body.
5. Append platform footer containing ticket id, job id, run id, test summary, policy gate summary, base SHA, and head SHA.
6. Store PR metadata in Postgres.
7. Update Lark managed fields with outcome and PR URL.

## 14. Admin UI

Admin UI is an operations console protected by `ADMIN_TOKEN`.

Job list:

- Outcome
- Current phase
- Attempt
- Priority
- Repository
- Target branch
- Work branch
- Queue wait
- Runtime
- Last heartbeat
- Last event
- PR link
- Failure category

Job detail:

- Current outcome and phase
- Error summary
- Next action
- Ticket snapshot
- Run timeline
- Attempt history
- Heartbeat and runtime
- Branch and commit metadata
- PR metadata
- Policy gate report
- Artifacts
- Raw logs with source filter, search, timestamps, copy, and download
- Retry preflight
- Cancel status

Config and health:

- `EXECUTOR_MODE`
- Runner image digest
- GitHub auth status
- Repository allowlist
- Lark connection status
- Worker heartbeat
- Queue depth
- Redis health
- Postgres health
- Token configured/masked status

Audit trail:

- Webhook trigger source
- Lark record id
- Trigger version
- Job id
- Run id
- Attempt
- State transition timestamps
- Target commit SHA
- Created branch
- PR URL
- Retry actor
- Cancel actor
- Failure category

## 15. REST API

MVP endpoints:

- `POST /webhooks/lark`
- `GET /api/health`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/logs`
- `GET /api/jobs/:id/events`
- `GET /api/jobs/:id/artifacts`
- `POST /api/jobs/:id/cancel`
- `POST /api/jobs/:id/retry`

Admin write endpoints require `ADMIN_TOKEN` and write audit events.

## 16. Packaging and Configuration

Install flow:

```bash
git clone <repo>
cp .env.example .env
docker compose up -d
```

Required environment variables:

- `PUBLIC_BASE_URL`
- `ADMIN_TOKEN`
- `DATABASE_URL`
- `REDIS_URL`
- `LARK_APP_ID`
- `LARK_APP_SECRET`
- `LARK_WEBHOOK_SECRET`
- `GITHUB_TOKEN`
- `REPOSITORY_ALLOWLIST`
- `JOB_WORKSPACE_ROOT`
- `JOB_TIMEOUT_SECONDS`
- `FAILED_WORKSPACE_RETENTION_DAYS`
- `EXECUTOR_MODE`
- `RUNNER_IMAGE`

Runner hardening defaults:

- Non-root user.
- Docker socket is not mounted.
- Workspace-only volume mount.
- Resource limits.
- Minimal environment variables.
- No broad host mounts.
- Secret values masked in logs.
- Failed workspace retention with cleanup.

## 17. Testing Strategy

Unit tests:

- Lark field validation.
- Trigger condition evaluation.
- Idempotency key generation.
- Repository allowlist validation.
- Branch name generation.
- State transition rules.
- Result schema validation.
- Policy gate checks.
- Token masking.

Integration tests:

- Lark webhook creates a job and enqueues BullMQ delivery.
- Duplicate webhook does not create duplicate active job.
- Worker processes mock executor result and completes job.
- Failed result creates correct failure category and next action.
- Policy gate failure prevents push/PR.
- PR metadata is stored after platform publish.
- Admin API returns job, timeline, artifacts, and logs.
- Retry creates a new attempt.
- Cancel stops queued/running work where possible.

Docker smoke:

- `docker compose up` starts API, worker, Postgres, and Redis.
- `/api/health` passes.
- Mock Lark webhook creates a job.
- `EXECUTOR_MODE=mock` reaches `NeedsReview` with simulated PR metadata.
- Admin UI shows timeline, logs, artifacts, and the simulated PR result.

Real executor smoke:

- `EXECUTOR_MODE=gstack` against a test repository.
- Runner creates local commit.
- Platform policy gate passes.
- Platform pushes branch.
- Platform creates PR.
- Admin UI and Lark show PR URL.

## 18. MVP Acceptance Criteria

- A Lark Base ticket with required fields can trigger a job.
- Invalid trigger conditions do not create jobs.
- Duplicate webhooks do not create duplicate active jobs.
- A job is delivered through Redis/BullMQ to the worker.
- Each run uses an isolated runner container from the fixed runner image.
- The runner creates file-based input artifacts.
- gstack/Claude modifies code and creates local commit(s).
- gstack/Claude writes valid `result.json`, PR title, and PR body draft.
- Platform policy gate runs before publishing.
- Platform blocks policy failures before push.
- Platform pushes the work branch only after required gates pass.
- Platform opens the PR and stores PR metadata.
- Admin UI shows job list, run timeline, error summary, logs, artifacts, and PR link.
- Retry creates a new attempt with audit history.
- Cancel records clear cancel state and attempts to stop running work.
- Failed workspaces are retained and successful workspaces are cleaned.
- The stack can run on a personal computer with Docker Compose.

## 19. V2 Direction

- GitHub App authentication and installation tokens.
- Jira support.
- GitHub Issue support.
- Slack notifications.
- Multi-agent workflow.
- AI reviewer agent.
- AI QA agent.
- Auto merge with strict policy gates.
- Auto deploy.
- Release notes.
- Sprint reports.
