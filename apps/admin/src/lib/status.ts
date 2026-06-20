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

// Live progress of the staged gstack runner, parsed from its stdout banners
// (`=== gstack stage 3/4: review ===`). Best-effort: returns the latest banner.
export interface StageProgress {
  index: number;
  total: number;
  key: string;
}

const STAGE_BANNER = /gstack stage (\d+)\/(\d+):\s*([a-z]+)/i;

export function isStageBannerText(text: string | undefined | null): boolean {
  return Boolean(text && STAGE_BANNER.test(text));
}

export function parseStageProgress(logs: ReadonlyArray<{ text?: string | null }>): StageProgress | null {
  let latest: StageProgress | null = null;
  for (const line of logs) {
    const match = line.text ? STAGE_BANNER.exec(line.text) : null;
    if (match) latest = { index: Number(match[1]), total: Number(match[2]), key: match[3].toLowerCase() };
  }
  return latest;
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
