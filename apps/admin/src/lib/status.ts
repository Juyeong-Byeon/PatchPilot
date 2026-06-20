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

export type StatusFilter = "all" | "running" | "failed" | "completed";

export function matchesStatusFilter(
  job: { phase?: unknown; outcome?: unknown },
  filter: StatusFilter
): boolean {
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
