import { useMemo } from "react";
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
  eventCount: number;
  latestMessage: string;
  sources: string[];
  durationMs: number;
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
          <span className="text-[12px] leading-4 text-charcoal">{copy.stepGraphSummary}</span>
        </div>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-3 lg:grid-cols-6" aria-label={copy.stepGraph}>
          {steps.map((step, index) => {
            const selected = selectedStep?.phase === step.phase;
            return (
              <li className="relative min-w-0" key={step.phase}>
                {index < steps.length - 1 ? (
                  <span
                    className={`absolute left-[calc(50%+18px)] right-[-50%] top-5 hidden h-px lg:block ${connectorClass(step.status)}`}
                    aria-hidden="true"
                  />
                ) : null}
                <button
                  className={`relative grid w-full min-w-0 gap-2 rounded-xl border bg-linen-white p-3 text-left transition-colors ${
                    selected ? "border-forest-ink ring-2 ring-forest-ink/10" : "border-hairline-gray hover:border-forest-ink hover:bg-linen"
                  }`}
                  type="button"
                  onClick={() => onSelectStep?.({ phase: step.phase, source: step.sources[0] })}
                >
                  <span className="flex items-center gap-2">
                    <span className={`flex size-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${nodeClass(step.status)}`}>
                      {statusGlyph(step.status)}
                    </span>
                    <span className="min-w-0">
                      <strong className="block truncate text-[13px] font-semibold leading-5 text-true-black">
                        {translateState(step.phase, locale)}
                      </strong>
                      <span className="block text-[12px] leading-4 text-charcoal">{statusLabel(step.status, copy)}</span>
                    </span>
                  </span>
                  <span className="grid gap-1 text-[12px] leading-4 text-charcoal">
                    <span className="truncate">{step.latestMessage || copy.stepWaitingForSignal}</span>
                    <span className="flex items-center justify-between gap-2">
                      <span>{step.eventCount > 0 ? copy.spanEvents(step.eventCount) : copy.spanNoEvents}</span>
                      <span className="font-mono">{formatDuration(step.durationMs)}</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
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
  const eventTimes = events.map((event) => parseDate(event.created_at)).filter((time): time is number => time !== null);
  const firstOverall = eventTimes[0] ?? 0;
  const lastOverall = eventTimes[eventTimes.length - 1] ?? firstOverall;

  return phaseFlow.map((phase, index) => {
    const phaseEvents = events.filter((event) => event.phase === phase);
    const phaseTimes = phaseEvents.map((event) => parseDate(event.created_at)).filter((time): time is number => time !== null);
    const hasFailure = phaseEvents.some(isFailureEvent) || (terminalFailure && index === currentIndex);
    const status = hasFailure
      ? "failed"
      : index < currentIndex
        ? phaseEvents.length > 0 ? "complete" : "skipped"
        : index === currentIndex
          ? activeStatus(currentPhase)
          : "pending";
    const latestMessage = [...phaseEvents].reverse().find((event) => event.message)?.message ?? "";
    const sources = Array.from(new Set(phaseEvents.map((event) => event.source).filter(Boolean) as string[]));
    const durationMs =
      phaseTimes.length > 0
        ? Math.max(0, phaseTimes[phaseTimes.length - 1] - phaseTimes[0])
        : index < currentIndex
          ? Math.max(0, lastOverall - firstOverall)
          : 0;

    return {
      phase,
      status,
      eventCount: phaseEvents.length,
      latestMessage,
      sources,
      durationMs
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

function nodeClass(status: StepStatus): string {
  if (status === "failed") return "bg-forest-ink text-linen-white";
  if (status === "active") return "bg-sage-wash text-forest-ink";
  if (status === "complete") return "bg-mint-veil text-forest-ink";
  if (status === "skipped") return "border border-hairline-gray bg-linen text-graphite";
  return "border border-hairline-gray bg-linen-white text-graphite";
}

function connectorClass(status: StepStatus): string {
  if (status === "failed") return "bg-forest-ink";
  if (status === "pending" || status === "skipped") return "bg-hairline-gray";
  return "bg-sage-wash";
}

function statusGlyph(status: StepStatus): string {
  if (status === "failed") return "!";
  if (status === "active") return "...";
  if (status === "complete") return "✓";
  if (status === "skipped") return "-";
  return "";
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

function parseDate(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) return "0s";
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
