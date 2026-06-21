import { useMemo, type KeyboardEvent } from "react";
import type { RunEvent } from "../api.js";
import { translateState, type AdminCopy, type Locale } from "../i18n.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";

interface RunTimelineProps {
  events: RunEvent[];
  copy: AdminCopy;
  locale: Locale;
  selectedSpan?: SpanSelection | null;
  onSelectSpan?(selection: SpanSelection): void;
  variant?: "card" | "embedded";
  currentPhase?: string;
  nowMs?: number;
}

export interface SpanSelection {
  phase: string;
  source?: string;
}

const standardPhaseFlow = ["Queued", "Planning", "Implementing", "PolicyChecking", "Publishing", "Completed"];

interface PhaseSpan {
  phase: string;
  status: "pending" | "complete" | "active" | "failed";
  sources: string[];
  durationMs: number;
}

export function RunTimeline({
  events,
  copy,
  locale,
  selectedSpan,
  onSelectSpan,
  variant = "card",
  currentPhase,
  nowMs,
}: RunTimelineProps) {
  const orderedEvents = useMemo(
    () =>
      [...events].sort((left, right) => {
        const leftTime = Date.parse(left.created_at ?? "");
        const rightTime = Date.parse(right.created_at ?? "");
        return (Number.isNaN(leftTime) ? 0 : leftTime) - (Number.isNaN(rightTime) ? 0 : rightTime);
      }),
    [events],
  );
  const effectiveNowMs = nowMs ?? Date.now();
  const spans = useMemo(
    () => buildPhaseSpans(orderedEvents, currentPhase, effectiveNowMs),
    [currentPhase, effectiveNowMs, orderedEvents],
  );
  const totalRunDuration = Math.max(1, totalDuration(spans));

  const content = (
    <section aria-label={copy.traceFlow} className={variant === "embedded" ? "" : "px-4 py-3"}>
      <div className="mb-4 flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
        <div>
          <h3 className="text-[13px] font-semibold leading-5 text-forest-ink">{copy.traceFlow}</h3>
          {copy.traceFlowSummary ? (
            <p className="m-0 text-[12px] leading-4 text-charcoal">{copy.traceFlowSummary}</p>
          ) : null}
        </div>
        <span className="text-[12px] leading-4 text-charcoal">{formatDuration(totalDuration(spans))}</span>
      </div>

      <div className="surface-card-soft overflow-x-auto rounded-lg border border-hairline-gray">
        <table
          className="w-full min-w-[720px] table-fixed border-collapse text-left text-[13px]"
          aria-label={copy.traceFlow}
        >
          <thead className="bg-linen-white/95 text-[12px] font-medium leading-4 text-charcoal">
            <tr className="border-b border-hairline-gray">
              <th className="w-[44px] px-3 py-2">{copy.traceColumnIndex}</th>
              <th className="w-[112px] px-3 py-2">{copy.traceColumnStage}</th>
              <th className="w-[112px] px-3 py-2">{copy.traceColumnStatus}</th>
              <th className="w-[112px] px-3 py-2">{copy.traceColumnService}</th>
              <th className="w-[340px] px-3 py-2 text-right">{copy.traceColumnDuration}</th>
            </tr>
          </thead>
          <tbody>
            {spans.map((span, index) => {
              const selected =
                selectedSpan?.phase === span.phase &&
                (!selectedSpan.source || span.sources.includes(selectedSpan.source));
              const source = span.sources.join(", ") || copy.sourceSystem;

              return (
                <tr
                  aria-selected={selected}
                  className={`interactive-row cursor-pointer border-b border-hairline-gray outline-none last:border-b-0 hover:bg-mist-blue focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-electric-blue/25 ${selected ? "bg-mist-blue ring-1 ring-inset ring-electric-blue" : ""}`}
                  data-phase={span.phase}
                  data-status={span.status}
                  key={span.phase}
                  onClick={() => onSelectSpan?.({ phase: span.phase, source: span.sources[0] })}
                  onKeyDown={(event) => selectWithKeyboard(event, span, onSelectSpan)}
                  tabIndex={0}
                >
                  <td className="px-3 py-2 font-mono text-[12px] text-charcoal">{index}</td>
                  <td className="min-w-0 px-3 py-2">
                    <span className="block truncate font-medium text-true-black">
                      {translateState(span.phase, locale)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[12px] leading-4 shadow-sm ${statusClassName(span.status)}`}
                    >
                      {statusLabel(span.status, copy)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="block truncate text-forest-ink" title={source}>
                      {source}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-3">
                      <div className="h-2 min-w-[180px] flex-1 overflow-hidden rounded-full bg-linen shadow-inner">
                        <div
                          className={`duration-bar h-full rounded-full ${durationBarClassName(span.status)}`}
                          data-duration-bar
                          style={{ width: `${durationWidth(span.durationMs, totalRunDuration)}%` }}
                        />
                      </div>
                      <span className="w-14 shrink-0 text-right font-mono text-[12px] text-charcoal">
                        {formatDuration(span.durationMs)}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );

  if (variant === "embedded") return content;

  return (
    <Card>
      <CardHeader className="items-start">
        <div>
          <CardTitle>{copy.runTimeline}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="p-0">{content}</CardContent>
    </Card>
  );
}

function buildPhaseSpans(events: RunEvent[], currentPhase: string | undefined, nowMs: number): PhaseSpan[] {
  const observedPhases = events
    .map((event) => String(event.phase ?? ""))
    .filter((phase) => phase && !isTerminalFailurePhase(phase));
  const phaseFlow = [...standardPhaseFlow];
  for (const phase of observedPhases) {
    if (!phaseFlow.includes(phase)) phaseFlow.push(phase);
  }
  if (currentPhase && !isTerminalFailurePhase(currentPhase) && !phaseFlow.includes(currentPhase)) {
    phaseFlow.push(currentPhase);
  }

  const failedPhase = resolveFailedPhase(events, currentPhase);
  const eventTimes = events.map((event) => parseDate(event.created_at)).filter((time): time is number => time !== null);
  const firstOverall = eventTimes[0] ?? 0;
  const lastObservedIndex = Math.max(
    -1,
    ...phaseFlow.map((phase, index) => (events.some((event) => event.phase === phase) ? index : -1)),
  );
  const currentIndex =
    failedPhase && phaseFlow.includes(failedPhase)
      ? phaseFlow.indexOf(failedPhase)
      : currentPhase && phaseFlow.includes(currentPhase)
        ? phaseFlow.indexOf(currentPhase)
        : lastObservedIndex;
  const terminalPhase = isTerminalPhase(currentPhase);

  return phaseFlow.map((phase, index) => {
    const phaseEvents = events.filter((event) => event.phase === phase);
    const phaseTimes = phaseEvents
      .map((event) => parseDate(event.created_at))
      .filter((time): time is number => time !== null);
    const isCurrentActive = !terminalPhase && index === currentIndex;
    const firstTime =
      phaseTimes[0] ?? (isCurrentActive ? inferActiveStartTime(events, phaseFlow, index, firstOverall) : firstOverall);
    const lastTime = phaseTimes[phaseTimes.length - 1] ?? firstTime;
    const nextPhaseTime = events
      .map((event) => ({ phase: event.phase, time: parseDate(event.created_at) }))
      .find((event) => event.time !== null && event.time > firstTime && event.phase !== phase)?.time;
    const hasFailure = phase === failedPhase || phaseEvents.some(isFailureEvent);
    const status = hasFailure
      ? "failed"
      : isCurrentActive
        ? "active"
        : phaseEvents.length === 0
          ? "pending"
          : index < currentIndex || terminalPhase || phase === "Completed"
            ? "complete"
            : "pending";
    const endTime = status === "active" ? nowMs : (nextPhaseTime ?? lastTime);
    const sources = Array.from(new Set(phaseEvents.map((event) => event.source).filter(Boolean) as string[]));
    const inferredSources =
      sources.length > 0 ? sources : isCurrentActive ? inferActiveSources(events, phaseFlow, index) : [];
    return {
      phase,
      status,
      sources: inferredSources,
      durationMs: phaseEvents.length > 0 || status === "active" ? Math.max(0, endTime - firstTime) : 0,
    };
  });
}

function inferActiveStartTime(events: RunEvent[], phaseFlow: string[], currentIndex: number, fallback: number): number {
  const precedingEvents = events
    .map((event) => ({
      phaseIndex: phaseFlow.indexOf(String(event.phase ?? "")),
      time: parseDate(event.created_at),
    }))
    .filter(
      (event): event is { phaseIndex: number; time: number } =>
        event.time !== null && event.phaseIndex >= 0 && event.phaseIndex < currentIndex,
    );
  if (precedingEvents.length > 0) return precedingEvents[precedingEvents.length - 1]?.time ?? fallback;

  const latestEventTime = [...events]
    .reverse()
    .map((event) => parseDate(event.created_at))
    .find((time): time is number => time !== null);
  return latestEventTime ?? fallback;
}

function inferActiveSources(events: RunEvent[], phaseFlow: string[], currentIndex: number): string[] {
  const latestSource = [...events].reverse().find((event) => {
    const phaseIndex = phaseFlow.indexOf(String(event.phase ?? ""));
    return phaseIndex >= 0 && phaseIndex < currentIndex && Boolean(event.source);
  })?.source;
  return latestSource ? [latestSource] : [];
}

function selectWithKeyboard(
  event: KeyboardEvent<HTMLTableRowElement>,
  span: PhaseSpan,
  onSelectSpan: RunTimelineProps["onSelectSpan"],
) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onSelectSpan?.({ phase: span.phase, source: span.sources[0] });
}

function statusLabel(status: PhaseSpan["status"], copy: AdminCopy): string {
  if (status === "failed") return copy.spanFailurePoint;
  if (status === "active") return copy.spanActive;
  if (status === "complete") return copy.spanComplete;
  return copy.spanPending;
}

function statusClassName(status: PhaseSpan["status"]): string {
  if (status === "failed") return "bg-danger text-white shadow-danger/15";
  if (status === "active") return "bg-cobalt-surface text-paper shadow-cobalt-surface/15";
  if (status === "complete") return "bg-mist-blue text-forest-ink shadow-electric-blue/10";
  return "border border-hairline-gray bg-linen-white text-graphite";
}

function durationBarClassName(status: PhaseSpan["status"]): string {
  if (status === "failed") return "bg-danger";
  if (status === "pending") return "bg-hairline-gray";
  return "bg-electric-blue";
}

function durationWidth(durationMs: number, longestDurationMs: number): number {
  if (durationMs <= 0) return 1;
  return clamp((durationMs / longestDurationMs) * 100, 4, 100);
}

function totalDuration(spans: PhaseSpan[]): number {
  return spans.reduce((sum, span) => sum + span.durationMs, 0);
}

function isFailureEvent(event: RunEvent): boolean {
  const phase = String(event.phase ?? "").toLowerCase();
  const type = String(event.event_type ?? event.eventType ?? "").toLowerCase();
  return (
    phase.includes("fail") ||
    phase.includes("cancel") ||
    type.includes("failed") ||
    type.includes("error") ||
    type.includes("blocked") ||
    type.includes("cancel")
  );
}

function resolveFailedPhase(events: RunEvent[], currentPhase: string | undefined): string | undefined {
  const terminalFailureIndex = events.findIndex((event) => isTerminalFailurePhase(event.phase));
  if (terminalFailureIndex >= 0) {
    return lastNonTerminalPhase(events, terminalFailureIndex - 1);
  }

  if (isTerminalFailure(currentPhase)) {
    return lastNonTerminalPhase(events, events.length - 1);
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    const phase = String(event.phase ?? "");
    if (phase && !isTerminalFailurePhase(phase) && isFailureEvent(event)) return phase;
  }

  return undefined;
}

function lastNonTerminalPhase(events: RunEvent[], startIndex: number): string | undefined {
  for (let index = startIndex; index >= 0; index -= 1) {
    const phase = String(events[index]?.phase ?? "");
    if (phase && !isTerminalFailurePhase(phase)) return phase;
  }
  return undefined;
}

function parseDate(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function isTerminalPhase(phase: string | undefined): boolean {
  return phase === "Completed" || phase === "Failed" || phase === "Cancelled" || phase === "CancelFailed";
}

function isTerminalFailure(phase: string | undefined): boolean {
  const normalized = String(phase ?? "").toLowerCase();
  return normalized.includes("fail") || normalized.includes("cancel");
}

function isTerminalFailurePhase(phase: unknown): boolean {
  const normalized = String(phase ?? "").toLowerCase();
  return normalized === "failed" || normalized === "cancelled" || normalized === "cancelfailed";
}

function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) return "0s";
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
