import { AlertCircle, Check, LoaderCircle, Minus } from "lucide-react";
import { stageKeyLabel, type AdminCopy } from "../i18n.js";
import type { StageState, StageStatus } from "../lib/status.js";

interface StagePipelineProps {
  stages: StageState[];
  copy: AdminCopy;
}

/**
 * Sub-track for the staged runner's internal stages (plan → code → review →
 * verify), nested under the platform "Implementing" phase. Intentionally quieter
 * than the main step graph (ink for done, cobalt without glow for active) so it
 * reads as a level below it. Renders nothing when there are no stages — the
 * parent only mounts this for staged runs that have emitted stage events.
 */
export function StagePipeline({ stages, copy }: StagePipelineProps) {
  if (stages.length === 0) return null;

  return (
    <section
      className="relative mx-2 -mt-1 rounded-lg border border-electric-blue/25 bg-mist-blue/70 px-2 pb-1.5 pt-2 shadow-sm shadow-electric-blue/10"
      aria-label={copy.agentStages}
    >
      <span
        className="absolute left-1/2 top-0 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border-l border-t border-electric-blue/25 bg-mist-blue"
        aria-hidden="true"
      />
      <ol className="m-0 grid list-none gap-1 p-0" aria-label={copy.agentStages}>
        {stages.map((stage) => {
          return (
            <li
              className="grid min-h-5 grid-cols-[16px_minmax(0,1fr)] items-center gap-1.5"
              key={`${stage.index}-${stage.key}`}
              aria-label={`${stageKeyLabel(stage.key, copy)} ${statusLabel(stage.status, copy)}`}
            >
              <span className="flex justify-center" aria-hidden="true">
                <span
                  className={`flex size-3.5 items-center justify-center rounded-full border ${nodeClass(stage.status)}`}
                >
                  {statusGlyph(stage.status)}
                </span>
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[11px] font-medium leading-4 text-true-black">
                  {stageKeyLabel(stage.key, copy)}
                </span>
                <span className="sr-only">{statusLabel(stage.status, copy)}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function statusLabel(status: StageStatus, copy: AdminCopy): string {
  if (status === "failed") return copy.spanFailurePoint;
  if (status === "active") return copy.spanActive;
  if (status === "complete") return copy.spanComplete;
  if (status === "skipped") return copy.stepSkipped;
  return copy.spanPending;
}

// Quieter palette than the main step graph: ink (not electric-blue) for done and
// cobalt without glow for active, so the sub-track visually sits a level below.
function nodeClass(status: StageStatus): string {
  if (status === "failed") return "border-danger bg-danger text-white";
  if (status === "active") return "border-cobalt-surface bg-paper text-cobalt-surface";
  if (status === "complete") return "border-forest-ink bg-forest-ink text-paper";
  if (status === "skipped") return "border-hairline-gray bg-linen text-graphite";
  return "border-hairline-gray bg-linen-white text-graphite";
}

function statusGlyph(status: StageStatus) {
  if (status === "failed") return <AlertCircle aria-hidden="true" size={10} strokeWidth={2.4} />;
  if (status === "active")
    return <LoaderCircle aria-hidden="true" className="animate-spin" size={11} strokeWidth={2.4} />;
  if (status === "complete") return <Check aria-hidden="true" size={10} strokeWidth={2.6} />;
  if (status === "skipped") return <Minus aria-hidden="true" size={10} strokeWidth={2.4} />;
  return <span className="size-1.5 rounded-full bg-current" />;
}
