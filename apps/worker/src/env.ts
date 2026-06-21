import { readLarkRecordUpdaterConfig, type LarkRecordUpdaterConfig } from "@ticket-to-pr/core";

export type WorkerExecutorMode = "mock" | "gstack";
export type WorkerPublisherMode = "mock" | "github";

export interface WorkerEnv {
  databaseUrl: string;
  redisUrl: string;
  executorMode: WorkerExecutorMode;
  publisherMode: WorkerPublisherMode;
  repositoryAllowlist: string[];
  protectedPathDenylist: string[];
  runnerImage: string;
  workspaceRoot: string;
  workspaceHostRoot?: string;
  gstackCommand?: string;
  /**
   * Explicit GSTACK_ARGS override. When set, it wins for every job regardless of
   * priority (back-compat) and forces the recorded executor mode. When unset, the
   * worker derives args per-job from priority via the staged/single args below.
   */
  gstackArgs?: string;
  /** GSTACK_ARGS used for the staged pipeline (High priority). */
  gstackStagedArgs: string;
  /** GSTACK_ARGS used for the single-pass pipeline (default). */
  gstackSingleArgs: string;
  codexAuthFile?: string;
  codexConfigFile?: string;
  codexSkillsDir?: string;
  gstackSkillSourceDir?: string;
  jobTimeoutSeconds: number;
  githubToken?: string;
  /** Reconcile poller cadence in ms. 0 disables the poller. */
  reconcileIntervalMs: number;
  /** Days to keep a FAILED job's workspace before the sweep GCs it (L1). */
  failedWorkspaceRetentionDays: number;
  /** Heartbeat write cadence in ms while a runner executes (L1). 0 disables. */
  runHeartbeatIntervalMs: number;
  /** Workspace sweep + orphan-container reap cadence in ms (L1). 0 disables. */
  workspaceSweepIntervalMs: number;
  larkRecordUpdaterConfig?: LarkRecordUpdaterConfig;
}

export function readWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const executorMode = parseMode(source.WORKER_EXECUTOR_MODE ?? source.EXECUTOR_MODE, ["mock", "gstack"], "mock");
  const publisherMode = source.WORKER_PUBLISHER_MODE
    ? parseMode(source.WORKER_PUBLISHER_MODE, ["mock", "github"], "mock")
    : parseMode(normalizeAppPublisherMode(source.PUBLISHER_MODE), ["mock", "github"], "mock");
  const githubToken = source.GITHUB_TOKEN;

  if (publisherMode === "github" && !githubToken) {
    throw new Error("GITHUB_TOKEN is required when WORKER_PUBLISHER_MODE=github");
  }

  return {
    databaseUrl: source.DATABASE_URL ?? "",
    redisUrl: source.REDIS_URL ?? "redis://localhost:6379",
    executorMode,
    publisherMode,
    repositoryAllowlist: parseCsv(source.POLICY_REPOSITORY_ALLOWLIST ?? source.REPOSITORY_ALLOWLIST),
    protectedPathDenylist: parseCsv(source.POLICY_PROTECTED_PATH_DENYLIST ?? source.PROTECTED_PATH_DENYLIST),
    runnerImage: source.GSTACK_RUNNER_IMAGE ?? source.RUNNER_IMAGE ?? "ticket-to-pr-runner:latest",
    workspaceRoot: source.WORKER_WORKSPACE_ROOT ?? source.JOB_WORKSPACE_ROOT ?? "/tmp/ticket-to-pr-worker",
    workspaceHostRoot: parseOptional(source.WORKER_WORKSPACE_HOST_ROOT ?? source.JOB_WORKSPACE_HOST_ROOT),
    gstackCommand: parseOptional(source.GSTACK_COMMAND),
    gstackArgs: parseOptional(source.GSTACK_ARGS),
    // GSTACK_ARGS is the runner JS entrypoint path (run as `node <path>`), not a CLI string.
    gstackStagedArgs:
      parseOptional(source.GSTACK_STAGED_ARGS) ?? "/opt/runner/apps/runner/dist/gstack-staged-runner.js",
    gstackSingleArgs: parseOptional(source.GSTACK_SINGLE_ARGS) ?? "/opt/runner/apps/runner/dist/codex-agent-runner.js",
    codexAuthFile: parseOptional(source.CODEX_AUTH_FILE),
    codexConfigFile: parseOptional(source.CODEX_CONFIG_FILE),
    codexSkillsDir: parseOptional(source.CODEX_SKILLS_DIR),
    gstackSkillSourceDir: parseOptional(source.GSTACK_SKILL_SOURCE_DIR),
    jobTimeoutSeconds: parsePositiveInteger(source.WORKER_JOB_TIMEOUT_SECONDS ?? source.JOB_TIMEOUT_SECONDS, 3600),
    githubToken,
    // 0 disables the reconcile poller; default 60s recovers from missed merge webhooks.
    reconcileIntervalMs: parseNonNegativeInteger(source.WORKER_RECONCILE_INTERVAL_MS, 60_000),
    // L1 workspace lifecycle. Failed workspaces kept 7 days for post-mortem by default.
    failedWorkspaceRetentionDays: parseNonNegativeInteger(source.FAILED_WORKSPACE_RETENTION_DAYS, 7),
    // 0 disables; default 30s heartbeat keeps a long run visibly alive.
    runHeartbeatIntervalMs: parseNonNegativeInteger(source.WORKER_RUN_HEARTBEAT_INTERVAL_MS, 30_000),
    // 0 disables; default hourly workspace sweep + orphan-container reap.
    workspaceSweepIntervalMs: parseNonNegativeInteger(source.WORKER_WORKSPACE_SWEEP_INTERVAL_MS, 3_600_000),
    larkRecordUpdaterConfig: readLarkRecordUpdaterConfig(source),
  };
}

function parseCsv(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function parseMode<T extends string>(value: string | undefined, allowed: T[], fallback: T): T {
  if (!value) return fallback;
  if (allowed.includes(value as T)) return value as T;
  throw new Error(`Invalid worker mode: ${value}`);
}

function parseOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeAppPublisherMode(value: string | undefined): string | undefined {
  return value === "gstack" ? "github" : value;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
}

// Like parsePositiveInteger but allows 0 (used as the "disable" sentinel).
function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid non-negative integer: ${value}`);
  return parsed;
}
