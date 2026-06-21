import type { BadgeProps } from "../components/ui/badge.js";

export type StatusBadgeVariant = NonNullable<BadgeProps["variant"]>;

const RUNNING_PHASES = ["Queued", "Planning", "Implementing", "PolicyChecking", "Publishing"];

export function isRunningPhase(phase: unknown): boolean {
  return RUNNING_PHASES.includes(String(phase));
}

export function isFailedJob(phase: unknown, outcome: unknown): boolean {
  return String(phase).startsWith("Failed") || String(outcome).startsWith("Failed");
}

export function isCompletedJob(phase: unknown, outcome: unknown): boolean {
  return phase === "Completed" || outcome === "Completed";
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
  if (normalized.includes("review") || normalized === "queued") return "warning"; // needs attention / waiting
  return "default"; // Running / in-flight phases
}

// `=== gstack stage N/M: key ===` banner detection, used only to highlight the
// banner line in the raw log viewer. Live sub-stage progress is derived from
// structured `gstack.stage` run events (see deriveStageStates), not from logs.
const STAGE_BANNER = /gstack stage (\d+)\/(\d+):\s*([a-z]+)/i;

export function isStageBannerText(text: string | undefined | null): boolean {
  return Boolean(text && STAGE_BANNER.test(text));
}

// Ordered keys of the staged runner's internal pipeline. The runner emits one
// `gstack.stage` event as it enters each stage; the admin renders them as a
// sub-track nested under the platform "Implementing" phase. (Kept local to the
// frontend — the browser bundle does not depend on @ticket-to-pr/core.)
export const GSTACK_STAGE_KEYS = ["plan", "implement", "review", "verify"] as const;
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
  const maxStarted = started[started.length - 1].index;
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

export type StatusFilter = "all" | "running" | "failed" | "completed";

export function matchesStatusFilter(job: { phase?: unknown; outcome?: unknown }, filter: StatusFilter): boolean {
  switch (filter) {
    case "running":
      return isRunningPhase(job.phase);
    case "failed":
      return isFailedJob(job.phase, job.outcome);
    case "completed":
      return isCompletedJob(job.phase, job.outcome);
    default:
      return true;
  }
}
