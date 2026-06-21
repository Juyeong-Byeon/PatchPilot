import { spawn } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Workspace lifecycle management (L1). Three responsibilities, all best-effort and
 * safe to call when the filesystem path does not exist or docker is unavailable
 * (mock mode): garbage-collect a successful job's workspace, sweep failed
 * workspaces past a retention window, and reap orphaned runner containers.
 *
 * Every operation swallows its own errors (optionally reporting via `onError`) so
 * housekeeping can never fail the job it is cleaning up after.
 */

const RUNNER_CONTAINER_PREFIX = "ticket-to-pr-";

export interface WorkspaceLifecycleConfig {
  /** Root that holds per-job workspaces (`<root>/<jobId>/<runId>`). */
  workspaceRoot: string;
  /** Days to keep a FAILED job's workspace for post-mortem before GC. */
  failedRetentionDays: number;
  onError?: (context: string, error: unknown) => void;
}

/**
 * Resolve the EFFECTIVE retention window for a sweep tick. The poller reads this
 * each tick so a live `failedWorkspaceRetentionDays` override (Settings page) applies
 * without a worker restart. Falls back to the static `failedRetentionDays` when no
 * resolver is wired (back-compat).
 */
export type ResolveRetentionDays = () => Promise<number> | number;

/**
 * GC a successful job's workspace after publish. We remove the whole per-job dir
 * (all attempts) because a completed job will not be retried. No-op if the path is
 * already gone.
 */
export async function gcSuccessfulWorkspace(
  jobId: string,
  config: Pick<WorkspaceLifecycleConfig, "workspaceRoot" | "onError">,
): Promise<void> {
  const jobDir = join(config.workspaceRoot, jobId);
  await rm(jobDir, { recursive: true, force: true }).catch((error) => config.onError?.("gcSuccessfulWorkspace", error));
}

/**
 * Sweep per-job workspaces whose most-recent modification is older than the failed
 * retention window. Runs over the whole workspace root (cheap directory stat), so a
 * single periodic call cleans up everything aged out, including workspaces orphaned
 * by a worker crash. Returns the job dirs it removed (for logging/tests).
 */
export async function sweepExpiredWorkspaces(
  config: WorkspaceLifecycleConfig,
  retentionDaysOverride?: number,
): Promise<string[]> {
  const retentionDays = retentionDaysOverride ?? config.failedRetentionDays;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = await readdir(config.workspaceRoot);
  } catch (error) {
    // Root does not exist yet (no jobs ran) — nothing to sweep.
    if (isEnoent(error)) return [];
    config.onError?.("sweepExpiredWorkspaces.readdir", error);
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries) {
    const jobDir = join(config.workspaceRoot, entry);
    try {
      const info = await stat(jobDir);
      if (!info.isDirectory()) continue;
      if (info.mtimeMs >= cutoff) continue;
      await rm(jobDir, { recursive: true, force: true });
      removed.push(jobDir);
    } catch (error) {
      config.onError?.(`sweepExpiredWorkspaces.${entry}`, error);
    }
  }
  return removed;
}

/** Runs a docker CLI command and returns stdout. Injectable for tests. */
export type DockerRunner = (args: string[]) => Promise<string>;

/**
 * Reap orphaned runner containers: any `ticket-to-pr-*` container that is no longer
 * tied to a live run. `activeRunIds` are the runs the worker believes are in flight;
 * a container whose run id is not among them is force-removed. Docker-safe: if the
 * docker CLI is missing or errors, this is a silent no-op. Returns the container
 * names it removed. `docker` is injectable so tests never touch real containers.
 */
export async function sweepOrphanRunnerContainers(
  activeRunIds: ReadonlySet<string>,
  onError?: (context: string, error: unknown) => void,
  docker: DockerRunner = runDocker,
): Promise<string[]> {
  let listed: string;
  try {
    listed = await docker(["ps", "-a", "--filter", `name=${RUNNER_CONTAINER_PREFIX}`, "--format", "{{.Names}}"]);
  } catch (error) {
    // Docker unavailable (mock mode) or CLI error — no-op.
    onError?.("sweepOrphanRunnerContainers.ps", error);
    return [];
  }

  const names = listed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(RUNNER_CONTAINER_PREFIX));

  const removed: string[] = [];
  for (const name of names) {
    const runId = name.slice(RUNNER_CONTAINER_PREFIX.length);
    if (activeRunIds.has(runId)) continue;
    try {
      await docker(["rm", "-f", name]);
      removed.push(name);
    } catch (error) {
      onError?.(`sweepOrphanRunnerContainers.rm.${name}`, error);
    }
  }
  return removed;
}

export interface WorkspaceLifecyclePollerHandle {
  stop(): void;
}

/**
 * Periodic L1 housekeeping: every `intervalMs`, sweep expired (failed/orphaned)
 * workspaces and reap orphaned runner containers. `getActiveRunIds` returns the
 * runs currently in flight so their containers/workspaces are never reaped. Returns
 * a handle to stop the timer (shutdown/tests). A non-positive interval disables it
 * and returns null.
 */
export function startWorkspaceLifecyclePoller(
  config: WorkspaceLifecycleConfig & {
    intervalMs: number;
    getActiveRunIds: () => ReadonlySet<string>;
    /**
     * Resolve the EFFECTIVE retention window each tick (env ⊕ DB override; Settings
     * page) so a live `failedWorkspaceRetentionDays` override applies without a
     * worker restart. Optional: when absent the static `failedRetentionDays` is used.
     */
    resolveRetentionDays?: ResolveRetentionDays;
  },
): WorkspaceLifecyclePollerHandle | null {
  if (config.intervalMs <= 0) return null;
  const tick = async () => {
    // Read the live retention override each tick; on failure fall back to the static
    // value so a settings read never breaks the sweep.
    let retentionDays = config.failedRetentionDays;
    if (config.resolveRetentionDays) {
      try {
        retentionDays = await config.resolveRetentionDays();
      } catch (error) {
        config.onError?.("resolveRetentionDays", error);
      }
    }
    await sweepExpiredWorkspaces(config, retentionDays);
    await sweepOrphanRunnerContainers(config.getActiveRunIds(), config.onError);
  };
  const timer = setInterval(tick, config.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function runDocker(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject); // docker binary missing
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else
        reject(
          new Error(`docker ${args.join(" ")} exited ${code ?? "unknown"}: ${Buffer.concat(err).toString("utf8")}`),
        );
    });
  });
}
