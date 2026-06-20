import { useMemo } from "react";
import { AlertCircle, CheckCircle2, CircleDashed, LoaderCircle, MinusCircle } from "lucide-react";
import type { RunEvent } from "../api.js";
import { translateState, type AdminCopy, type Locale } from "../i18n.js";
import type { SpanSelection } from "./RunTimeline.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";

interface RunStepGraphProps {
  events: RunEvent[];
  currentPhase?: string;
  copy: AdminCopy;
  locale: Locale;
  selectedStep?: SpanSelection | null;
  onSelectStep?(selection: SpanSelection): void;
}

type StepStatus = "pending" | "skipped" | "complete" | "active" | "failed";

interface GraphStep {
  phase: string;
  status: StepStatus;
}

const standardPhaseFlow = ["Queued", "Planning", "Implementing", "PolicyChecking", "Publishing", "Completed"];

export function RunStepGraph({ events, currentPhase, copy, locale, selectedStep, onSelectStep }: RunStepGraphProps) {
  const orderedEvents = useMemo(() => sortEvents(events), [events]);
  const steps = useMemo(() => buildGraphSteps(orderedEvents, currentPhase), [currentPhase, orderedEvents]);

  return (
    <Card>
      <CardHeader className="items-start">
        <div>
          <CardTitle>{copy.stepGraph}</CardTitle>
          {copy.stepGraphSummary ? <span className="text-[12px] leading-4 text-charcoal">{copy.stepGraphSummary}</span> : null}
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto pb-1">
          <ol className="m-0 grid min-w-[680px] auto-cols-[minmax(104px,1fr)] grid-flow-col list-none p-0" aria-label={copy.stepGraph}>
            {steps.map((step, index) => {
              const selected = selectedStep?.phase === step.phase;

              return (
                <li className="relative min-w-0" key={step.phase}>
                  {index < steps.length - 1 ? (
                    <span
                      className={`absolute left-[calc(50%+18px)] right-[calc(-50%+18px)] top-[18px] h-px ${connectorClass(step.status)}`}
                      aria-hidden="true"
                    />
                  ) : null}
                  <button
                    aria-label={`${translateState(step.phase, locale)} ${statusLabel(step.status, copy)}`}
                    className={`relative flex w-full min-w-0 flex-col items-center gap-2 rounded-lg px-2 pb-1 pt-0 text-center outline-none transition-colors ${
                      selected ? "text-forest-ink" : "text-charcoal hover:text-forest-ink"
                    }`}
                    type="button"
                    onClick={() => onSelectStep?.({ phase: step.phase })}
                  >
                    <span className={`relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full border ${nodeClass(step.status, selected)}`}>
                      {statusGlyph(step.status)}
                    </span>
                    <span className="grid w-full min-w-0 gap-0.5">
                      <strong className="truncate text-[13px] font-semibold leading-5 text-true-black">
                        {translateState(step.phase, locale)}
                      </strong>
                      <span className="text-[12px] leading-4 text-charcoal">{statusLabel(step.status, copy)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </CardContent>
    </Card>
  );
}

function sortEvents(events: RunEvent[]): RunEvent[] {
  return [...events].sort((left, right) => {
    const leftTime = Date.parse(left.created_at ?? "");
    const rightTime = Date.parse(right.created_at ?? "");
    return (Number.isNaN(leftTime) ? 0 : leftTime) - (Number.isNaN(rightTime) ? 0 : rightTime);
  });
}

function buildGraphSteps(events: RunEvent[], currentPhase: string | undefined): GraphStep[] {
  const observedPhases = events.map((event) => String(event.phase ?? "")).filter(Boolean);
  const phaseFlow = [...standardPhaseFlow];
  for (const phase of observedPhases) {
    if (!phaseFlow.includes(phase)) phaseFlow.push(phase);
  }

  const currentIndex = resolveCurrentIndex(phaseFlow, events, currentPhase);
  const terminalFailure = isTerminalFailure(currentPhase);

  return phaseFlow.map((phase, index) => {
    const phaseEvents = events.filter((event) => event.phase === phase);
    const hasFailure = phaseEvents.some(isFailureEvent) || (terminalFailure && index === currentIndex);
    const status = hasFailure
      ? "failed"
      : index < currentIndex
        ? phaseEvents.length > 0 ? "complete" : "skipped"
        : index === currentIndex
          ? activeStatus(currentPhase)
          : "pending";

    return {
      phase,
      status
    };
  });
}

function resolveCurrentIndex(phaseFlow: string[], events: RunEvent[], currentPhase: string | undefined): number {
  if (currentPhase && phaseFlow.includes(currentPhase)) return phaseFlow.indexOf(currentPhase);
  const lastObservedIndex = Math.max(
    0,
    ...phaseFlow.map((phase, index) => (events.some((event) => event.phase === phase) ? index : -1))
  );
  if (isTerminalFailure(currentPhase)) return lastObservedIndex;
  return lastObservedIndex;
}

function activeStatus(currentPhase: string | undefined): StepStatus {
  return currentPhase === "Completed" ? "complete" : "active";
}

function statusLabel(status: StepStatus, copy: AdminCopy): string {
  if (status === "failed") return copy.spanFailurePoint;
  if (status === "active") return copy.spanActive;
  if (status === "complete") return copy.spanComplete;
  if (status === "skipped") return copy.stepSkipped;
  return copy.spanPending;
}

function nodeClass(status: StepStatus, selected: boolean): string {
  if (status === "failed") return "border-forest-ink bg-forest-ink text-linen-white";
  if (status === "active") return "border-cobalt-surface bg-cobalt-surface text-paper";
  if (status === "complete") return "border-electric-blue bg-electric-blue text-paper";
  if (selected) return "border-cobalt-surface text-cobalt-surface";
  if (status === "skipped") return "border-hairline-gray bg-linen text-graphite";
  return "border-hairline-gray bg-linen-white text-graphite";
}

function connectorClass(status: StepStatus): string {
  if (status === "failed") return "bg-forest-ink";
  if (status === "pending" || status === "skipped") return "bg-hairline-gray";
  return "bg-electric-blue";
}

function statusGlyph(status: StepStatus) {
  if (status === "failed") return <AlertCircle aria-hidden="true" size={18} strokeWidth={2.4} />;
  if (status === "active") return <LoaderCircle aria-hidden="true" size={18} strokeWidth={2.4} />;
  if (status === "complete") return <CheckCircle2 aria-hidden="true" size={18} strokeWidth={2.4} />;
  if (status === "skipped") return <MinusCircle aria-hidden="true" size={18} strokeWidth={2.2} />;
  return <CircleDashed aria-hidden="true" size={18} strokeWidth={2.2} />;
}

function isFailureEvent(event: RunEvent): boolean {
  const phase = String(event.phase ?? "").toLowerCase();
  const type = String(event.event_type ?? event.eventType ?? "").toLowerCase();
  return phase.includes("fail") || phase.includes("cancel") || type.includes("failed") || type.includes("error") || type.includes("blocked") || type.includes("cancel");
}

function isTerminalFailure(phase: string | undefined): boolean {
  const normalized = String(phase ?? "").toLowerCase();
  return normalized.includes("fail") || normalized.includes("cancel");
}
