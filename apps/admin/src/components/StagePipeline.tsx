import { AlertCircle, CheckCircle2, CircleDashed, LoaderCircle, MinusCircle } from "lucide-react";
import type { AdminCopy } from "../i18n.js";
import type { StageState, StageStatus } from "../lib/status.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";

interface StagePipelineProps {
  stages: StageState[];
  nowMs: number;
  copy: AdminCopy;
}

/**
 * Sub-track for the staged runner's internal stages (plan → code → review →
 * verify), nested under the platform "Implementing" phase. Intentionally quieter
 * than the main step graph (ink for done, cobalt without glow for active) so it
 * reads as a level below it. Renders nothing when there are no stages — the
 * parent only mounts this for staged runs that have emitted stage events.
 */
export function StagePipeline({ stages, nowMs, copy }: StagePipelineProps) {
  if (stages.length === 0) return null;

  return (
    <Card>
      <CardHeader className="items-start">
        <div>
          <CardTitle>{copy.agentStages}</CardTitle>
          <span className="text-[12px] leading-4 text-charcoal">{copy.agentStagesHint}</span>
        </div>
      </CardHeader>
      <CardContent className="px-4 py-3">
        <div className="overflow-x-auto overflow-y-visible px-1 py-4">
          <ol
            className="m-0 grid min-w-[420px] auto-cols-[minmax(92px,1fr)] grid-flow-col list-none p-0"
            aria-label={copy.agentStages}
          >
            {stages.map((stage, index) => {
              const nextStage = stages[index + 1];
              return (
                <li className="relative min-h-[96px] min-w-0" key={`${stage.index}-${stage.key}`}>
                  {nextStage ? (
                    <span
                      className={`absolute left-[calc(50%+15px)] right-[calc(-50%+15px)] top-[20px] h-px transition-colors duration-300 ${connectorClass(stage.status, nextStage.status)}`}
                      aria-hidden="true"
                    />
                  ) : null}
                  <div className="flex min-h-[84px] flex-col items-center gap-2 px-1 text-center">
                    <span
                      className={`relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border transition-all duration-200 ${nodeClass(stage.status)}`}
                    >
                      {statusGlyph(stage.status)}
                    </span>
                    <span className="grid w-full min-w-0 gap-0.5">
                      <strong className="truncate text-[12px] font-semibold leading-4 text-true-black">
                        {stageLabel(stage.key, copy)}
                      </strong>
                      <span className="text-[11px] leading-4 text-charcoal">{statusLabel(stage.status, copy)}</span>
                      {elapsed(stage, nowMs) ? (
                        <span className="text-[11px] leading-4 text-graphite tabular-nums">
                          {elapsed(stage, nowMs)}
                        </span>
                      ) : null}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </CardContent>
    </Card>
  );
}

function stageLabel(key: string, copy: AdminCopy): string {
  const labels: Record<string, string> = {
    plan: copy.stagePlan,
    implement: copy.stageCode,
    review: copy.stageReview,
    verify: copy.stageQa,
    qa: copy.stageQa,
  };
  return labels[key] ?? key;
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
  if (status === "active") return "border-cobalt-surface bg-cobalt-surface text-paper";
  if (status === "complete") return "border-forest-ink bg-forest-ink text-paper";
  if (status === "skipped") return "border-hairline-gray bg-linen text-graphite";
  return "border-hairline-gray bg-linen-white text-graphite";
}

function connectorClass(status: StageStatus, nextStatus: StageStatus): string {
  if (status === "failed") return "bg-hairline-gray";
  if (status === "pending" || status === "skipped" || nextStatus === "pending" || nextStatus === "skipped")
    return "bg-hairline-gray";
  return "bg-forest-ink";
}

function statusGlyph(status: StageStatus) {
  if (status === "failed") return <AlertCircle aria-hidden="true" size={16} strokeWidth={2.4} />;
  if (status === "active")
    return <LoaderCircle aria-hidden="true" className="animate-spin" size={16} strokeWidth={2.4} />;
  if (status === "complete") return <CheckCircle2 aria-hidden="true" size={16} strokeWidth={2.4} />;
  if (status === "skipped") return <MinusCircle aria-hidden="true" size={16} strokeWidth={2.2} />;
  return <CircleDashed aria-hidden="true" size={16} strokeWidth={2.2} />;
}

function elapsed(stage: StageState, nowMs: number): string | null {
  if (stage.startMs === null) return null;
  if (stage.status === "complete" && stage.endMs !== null) return formatDuration(stage.endMs - stage.startMs);
  if (stage.status === "active") return formatDuration(nowMs - stage.startMs);
  return null;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) return "0s";
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
