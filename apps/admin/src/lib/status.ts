import type { BadgeProps } from "../components/ui/badge.js";

export type StatusBadgeVariant = NonNullable<BadgeProps["variant"]>;

const RUNNING_PHASES = ["Queued", "Planning", "Implementing", "PolicyChecking", "Publishing"];

export function isRunningPhase(phase: unknown): boolean {
  return RUNNING_PHASES.includes(String(phase));
}

/**
 * A job that is in the running set but has not actually started executing — it is
 * still parked in the queue. Visually this must be distinguishable from an active
 * run: a queued job is not "doing work" yet, so it should not show the same active
 * spinner/treatment as Planning/Implementing/etc. (accessibility: color- and
 * motion-independent, the caller pairs this with a distinct icon + label).
 */
export function isQueuedPhase(phase: unknown): boolean {
  return String(phase) === "Queued";
}

/**
 * Actively executing: in the running set AND past the queue. This is the set that
 * earns the live spinner + "running" affordance; Queued is deliberately excluded.
 */
export function isActiveRunningPhase(phase: unknown): boolean {
  return isRunningPhase(phase) && !isQueuedPhase(phase);
}

export function isFailedJob(phase: unknown, outcome: unknown): boolean {
  return String(phase).startsWith("Failed") || String(outcome).startsWith("Failed");
}

/**
 * A cancel that has been requested but not yet finalized. The backend keeps the
 * job's `outcome` at "Running" through CancelRequested/Cancelling (it only flips
 * to "Cancelled" once the runner actually stops), so callers that summarize a job
 * by its outcome must special-case these phases or the row keeps reading "Running"
 * after a cancel — possibly forever if the cancel never finalizes.
 */
export function isCancellingPhase(phase: unknown): boolean {
  return phase === "CancelRequested" || phase === "Cancelling";
}

export function isCompletedJob(phase: unknown, outcome: unknown): boolean {
  return phase === "Completed" || outcome === "Completed";
}

/**
 * A job that finished its pipeline (phase Completed) but is parked at outcome
 * NeedsReview, waiting on a human to review/merge the PR. This is the dominant
 * terminal state of a successful run, so it gets its own operator-facing label
 * ("PR 리뷰 대기") and list chip instead of being collapsed under "완료".
 */
export function isNeedsReviewJob(phase: unknown, outcome: unknown): boolean {
  return String(outcome) === "NeedsReview" || String(phase) === "NeedsReview";
}

/**
 * A job that is PARKED on a human answer (NeedsInput / 입력 대기): the agent asked
 * one blocking question only a human can resolve and the job is held at
 * phase=AwaitingInput / outcome=NeedsInput (no PR, no failure) until the operator
 * answers. Non-terminal — it resumes on answer — so it earns its own label, badge,
 * and list chip distinct from both NeedsReview and any failure.
 */
export function isNeedsInputJob(phase: unknown, outcome: unknown): boolean {
  return String(outcome) === "NeedsInput" || String(phase) === "AwaitingInput";
}

/**
 * The single operator-facing primary status for a job. The backend models status
 * as a (phase, outcome) pair, which previously surfaced as two badges that could
 * read as a contradiction (phase=Completed + outcome=NeedsReview). This collapses
 * the pair into one canonical state code so the UI shows ONE primary badge.
 *
 * Returned `code` is a state token translatable via `translateState`; callers map
 * it to a badge variant with `statusBadgeVariant`.
 */
export function resolvePrimaryStatus(job: { phase?: unknown; outcome?: unknown }): string {
  const phase = String(job.phase ?? "");
  const outcome = String(job.outcome ?? "");

  // A requested-but-not-finalized cancel keeps outcome="Running"; surface the
  // cancel intent so the badge never reads "Running" after a cancel. Both in-flight
  // cancel phases (CancelRequested / Cancelling) collapse to one operator-facing
  // state ("취소 중") — the distinction is internal, not operator-relevant.
  if (isCancellingPhase(phase)) return "Cancelling";

  // Parked on a human answer → one dedicated state. Checked before NeedsReview and
  // before the generic outcome handling so a parked job never reads as "Running".
  if (isNeedsInputJob(phase, outcome)) return "NeedsInput";

  // Successful pipeline completion parked on human review → one dedicated state.
  if (isNeedsReviewJob(phase, outcome)) return "NeedsReview";

  // Failures and explicit terminal outcomes win over the running phase.
  if (outcome && outcome !== "Running") return outcome;
  if (phase) return phase;
  return outcome || "";
}

/**
 * Single source of truth for status badge color. Keeps the taxonomy distinct so
 * a Completed job never looks like a Cancelled one (the previous logic collapsed
 * both to the neutral blue badge).
 */
export function statusBadgeVariant(value: unknown): StatusBadgeVariant {
  const normalized = String(value).toLowerCase();
  if (normalized.includes("failed")) return "danger"; // FailedActionable / FailedInternal / CancelFailed
  if (normalized.includes("cancel")) return "outline"; // Cancelled / CancelRequested — muted, intentional stop
  if (normalized === "completed") return "dark"; // sealed / done
  // Parked on a human answer → distinct info/violet tone, deliberately NOT the
  // amber of NeedsReview nor the red of a failure. Checked before the "review"
  // catch-all (which it does not match anyway) for clarity.
  if (normalized === "needsinput" || normalized === "awaitinginput") return "info";
  // Queued is a passive "not started yet" wait → muted neutral, deliberately
  // distinct from the amber "needs human attention" of NeedsReview and from the
  // blue active-running phases, so the three never read alike.
  if (normalized === "queued") return "outline";
  if (normalized.includes("review")) return "warning"; // needs attention / waiting
  return "default"; // Running / in-flight phases
}

// `=== gstack stage N/M: key ===` banner detection, used only to highlight the
// banner line in the raw log viewer. Live sub-stage progress is derived from
// structured `gstack.stage` run events (see deriveStageStates), not from logs.
const STAGE_BANNER = /gstack stage (\d+)\/(\d+):\s*([a-z]+)/i;

export function isStageBannerText(text: string | undefined | null): boolean {
  return Boolean(text && STAGE_BANNER.test(text));
}

// Ordered keys of the staged runner's pipeline (engineering stages + the final
// PR-description stage). The runner emits one `gstack.stage` event as it enters
// each stage; the admin renders them as a sub-track nested under the platform
// "Implementing" phase. Used here only as a label fallback — the live key/total
// come from the event metadata. (Kept local to the frontend — the browser bundle
// does not depend on @ticket-to-pr/core.)
export const GSTACK_STAGE_KEYS = ["plan", "implement", "review", "verify", "document"] as const;
export type GstackStageKey = (typeof GSTACK_STAGE_KEYS)[number];

export type StageStatus = "pending" | "active" | "complete" | "failed" | "skipped";

export interface StageState {
  index: number;
  key: string;
  status: StageStatus;
  startMs: number | null;
  endMs: number | null;
}

interface StageEventInput {
  event_type?: string;
  eventType?: string;
  metadata?: unknown;
  created_at?: string;
  phase?: string;
}

interface ParsedStageEvent {
  index: number;
  total: number;
  key: string;
  timeMs: number | null;
}

const PHASES_AFTER_IMPLEMENTING = ["PolicyChecking", "Publishing", "Completed"];

function isPhaseAfterImplementing(phase: unknown): boolean {
  return PHASES_AFTER_IMPLEMENTING.includes(String(phase));
}

// Terminal stop while still inside Implementing (failed or cancelled run). Brief
// in-flight states (CancelRequested/Cancelling) are intentionally excluded so the
// active stage keeps spinning until the run actually settles.
function isTerminallyStopped(phase: unknown, outcome: unknown): boolean {
  const p = String(phase);
  const o = String(outcome);
  return (
    p === "Failed" ||
    p === "Cancelled" ||
    p === "CancelFailed" ||
    o === "FailedInternal" ||
    o === "FailedActionable" ||
    o === "Cancelled"
  );
}

function readStageEvent(event: StageEventInput): ParsedStageEvent | null {
  const type = String(event.event_type ?? event.eventType ?? "");
  if (type !== "gstack.stage") return null;
  const meta = event.metadata;
  if (!meta || typeof meta !== "object") return null;
  const record = meta as Record<string, unknown>;
  const index = Number(record.stageIndex);
  if (!Number.isInteger(index) || index < 1) return null;
  const total = Number(record.stageTotal);
  const key = typeof record.stageKey === "string" ? record.stageKey : "";
  const time = event.created_at ? Date.parse(event.created_at) : Number.NaN;
  return {
    index,
    total: Number.isInteger(total) && total > 0 ? total : GSTACK_STAGE_KEYS.length,
    key: key || GSTACK_STAGE_KEYS[index - 1] || `stage ${index}`,
    timeMs: Number.isNaN(time) ? null : time,
  };
}

function firstTimeAfterImplementing(events: ReadonlyArray<StageEventInput>): number | null {
  let earliest: number | null = null;
  for (const event of events) {
    if (!isPhaseAfterImplementing(event.phase)) continue;
    const time = event.created_at ? Date.parse(event.created_at) : Number.NaN;
    if (Number.isNaN(time)) continue;
    if (earliest === null || time < earliest) earliest = time;
  }
  return earliest;
}

/**
 * Derive the state of the staged runner's internal sub-stages from a run's
 * `gstack.stage` events. Returns null when the run emitted no stage events
 * (non-staged runs, or before the first banner) so the caller can hide the
 * sub-track entirely. The job stays in the platform "Implementing" phase
 * throughout — this is sub-stage telemetry, not a phase-model change.
 */
export function deriveStageStates(
  events: ReadonlyArray<StageEventInput>,
  phase: unknown,
  outcome: unknown,
): StageState[] | null {
  const byIndex = new Map<number, ParsedStageEvent>();
  for (const event of events) {
    const stage = readStageEvent(event);
    if (!stage) continue;
    const existing = byIndex.get(stage.index);
    // Keep the earliest occurrence — the banner is emitted once on stage entry.
    if (!existing || (stage.timeMs ?? Infinity) < (existing.timeMs ?? Infinity)) {
      byIndex.set(stage.index, stage);
    }
  }
  if (byIndex.size === 0) return null;

  const started = [...byIndex.values()].sort((a, b) => a.index - b.index);
  const lastStarted = started[started.length - 1];
  if (!lastStarted) return null;
  const maxStarted = lastStarted.index;
  const total = Math.max(GSTACK_STAGE_KEYS.length, maxStarted, ...started.map((stage) => stage.total));

  const implementingDone =
    isPhaseAfterImplementing(phase) || events.some((event) => isPhaseAfterImplementing(event.phase));
  const stopped = !implementingDone && isTerminallyStopped(phase, outcome);
  const afterImplementMs = firstTimeAfterImplementing(events);

  const states: StageState[] = [];
  for (let index = 1; index <= total; index += 1) {
    const event = byIndex.get(index);
    const startMs = event?.timeMs ?? null;
    const key = event?.key ?? GSTACK_STAGE_KEYS[index - 1] ?? `stage ${index}`;
    let status: StageStatus;
    let endMs: number | null = null;

    if (index < maxStarted) {
      // A later stage has started, so this one finished.
      status = event ? "complete" : "skipped";
      endMs = started.find((stage) => stage.index > index)?.timeMs ?? null;
    } else if (index === maxStarted) {
      if (implementingDone) {
        status = "complete";
        endMs = afterImplementMs;
      } else if (stopped) {
        status = "failed";
      } else {
        status = "active";
      }
    } else {
      // Not yet reached. If implementing already finished, treat as done (a banner
      // may have been missed); otherwise it is still pending.
      status = implementingDone ? "complete" : "pending";
    }

    states.push({ index, key, status, startMs, endMs });
  }

  return states;
}

export type StatusFilter = "all" | "running" | "needsInput" | "needsReview" | "failed" | "completed";

export function matchesStatusFilter(job: { phase?: unknown; outcome?: unknown }, filter: StatusFilter): boolean {
  switch (filter) {
    case "running":
      // A parked NeedsInput job is held at phase=AwaitingInput, which is NOT in the
      // running set, so it is correctly excluded from "실행 중".
      return isRunningPhase(job.phase);
    case "needsInput":
      return isNeedsInputJob(job.phase, job.outcome);
    case "needsReview":
      return isNeedsReviewJob(job.phase, job.outcome);
    case "failed":
      // NeedsInput is a clean park, not a failure (phase/outcome never start with
      // "Failed"), so the two chips stay mutually exclusive.
      return isFailedJob(job.phase, job.outcome);
    case "completed":
      // "완료" means merged/sealed — exclude jobs still parked on PR review so the
      // two chips stay mutually exclusive and the operator can tell them apart.
      return isCompletedJob(job.phase, job.outcome) && !isNeedsReviewJob(job.phase, job.outcome);
    default:
      return true;
  }
}
