import { useMemo, type KeyboardEvent } from "react";
import type { RunEvent } from "../api.js";
import { translateEventType, translateState, type AdminCopy, type Locale } from "../i18n.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";

interface RunTimelineProps {
  events: RunEvent[];
  copy: AdminCopy;
  locale: Locale;
  selectedSpan?: SpanSelection | null;
  onSelectSpan?(selection: SpanSelection): void;
}

export interface SpanSelection {
  phase: string;
  source?: string;
}

const standardPhaseFlow = ["Queued", "Planning", "Implementing", "PolicyChecking", "Publishing", "Completed"];

interface PhaseSpan {
  phase: string;
  eventCount: number;
  status: "pending" | "complete" | "active" | "failed";
  sources: string[];
  durationMs: number;
}

export function RunTimeline({ events, copy, locale, selectedSpan, onSelectSpan }: RunTimelineProps) {
  const orderedEvents = useMemo(
    () =>
      [...events].sort((left, right) => {
        const leftTime = Date.parse(left.created_at ?? "");
        const rightTime = Date.parse(right.created_at ?? "");
        return (Number.isNaN(leftTime) ? 0 : leftTime) - (Number.isNaN(rightTime) ? 0 : rightTime);
      }),
    [events]
  );
  const spans = useMemo(() => buildPhaseSpans(orderedEvents), [orderedEvents]);
  const longestSpanDuration = Math.max(1, ...spans.map((span) => span.durationMs));

  return (
    <Card>
      <CardHeader className="items-start">
        <div>
          <CardTitle>{copy.runTimeline}</CardTitle>
          <span className="text-xs text-charcoal">{orderedEvents.length}</span>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <section aria-label={copy.traceFlow} className="border-b border-hairline-gray px-4 py-3">
          <div className="mb-4 flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
            <div>
              <h3 className="text-[13px] font-semibold leading-5 text-forest-ink">{copy.traceFlow}</h3>
              {copy.traceFlowSummary ? <p className="m-0 text-[12px] leading-4 text-charcoal">{copy.traceFlowSummary}</p> : null}
            </div>
            <span className="text-[12px] leading-4 text-charcoal">{formatDuration(totalDuration(spans))}</span>
          </div>

          <div className="overflow-x-auto rounded-lg border border-hairline-gray">
            <table className="w-full min-w-[760px] border-collapse text-left text-[13px]" aria-label={copy.traceFlow}>
              <thead className="bg-linen-white text-[12px] font-medium leading-4 text-charcoal">
                <tr className="border-b border-hairline-gray">
                  <th className="w-[52px] px-3 py-2">{copy.traceColumnIndex}</th>
                  <th className="px-3 py-2">{copy.traceColumnStage}</th>
                  <th className="w-[128px] px-3 py-2">{copy.traceColumnStatus}</th>
                  <th className="w-[136px] px-3 py-2">{copy.traceColumnService}</th>
                  <th className="w-[112px] px-3 py-2 text-right">{copy.traceColumnEvents}</th>
                  <th className="w-[240px] px-3 py-2 text-right">{copy.traceColumnDuration}</th>
                </tr>
              </thead>
              <tbody>
                {spans.map((span, index) => {
                  const selected = selectedSpan?.phase === span.phase && (!selectedSpan.source || span.sources.includes(selectedSpan.source));
                  const source = span.sources.join(", ") || copy.sourceSystem;

                  return (
                    <tr
                      aria-selected={selected}
                      className={`cursor-pointer border-b border-hairline-gray outline-none last:border-b-0 hover:bg-mist-blue ${selected ? "bg-mist-blue ring-1 ring-inset ring-electric-blue" : ""}`}
                      key={span.phase}
                      onClick={() => onSelectSpan?.({ phase: span.phase, source: span.sources[0] })}
                      onKeyDown={(event) => selectWithKeyboard(event, span, onSelectSpan)}
                      tabIndex={0}
                    >
                      <td className="px-3 py-2 font-mono text-[12px] text-charcoal">{index}</td>
                      <td className="min-w-0 px-3 py-2">
                        <span className="block truncate font-medium text-true-black">{translateState(span.phase, locale)}</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[12px] leading-4 ${statusClassName(span.status)}`}>
                          {statusLabel(span.status, copy)}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className="block truncate text-forest-ink" title={source}>{source}</span>
                      </td>
                      <td className="px-3 py-2 text-right text-charcoal">
                        {span.eventCount > 0 ? copy.spanEvents(span.eventCount) : copy.spanNoEvents}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-3">
                          <div className="h-2 w-32 overflow-hidden rounded-full bg-linen">
                            <div
                              className={`h-full rounded-full ${durationBarClassName(span.status)}`}
                              style={{ width: `${durationWidth(span.durationMs, longestSpanDuration)}%` }}
                            />
                          </div>
                          <span className="w-12 text-right font-mono text-[12px] text-charcoal">
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

        <div className="px-4 pt-3">
          <h3 className="text-[13px] font-semibold leading-5 text-forest-ink">{copy.eventLog}</h3>
        </div>
        <ol className="m-0 max-h-[320px] list-none overflow-auto p-0">
          {orderedEvents.map((event, index) => (
            <li className="grid gap-3 border-b border-hairline-gray px-4 py-3 text-[13px] md:grid-cols-[128px_minmax(0,1fr)_120px]" key={String(event.id ?? `${event.event_type ?? event.eventType}-${index}`)}>
              <time className="font-mono text-[12px] leading-4 text-charcoal">{formatDate(event.created_at, locale, copy)}</time>
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap gap-2">
                  <strong className="font-normal text-true-black">{translateEventType(event.event_type ?? event.eventType, locale)}</strong>
                  <span className="text-charcoal">{translateState(event.phase, locale)}</span>
                </div>
                <p className="m-0 mt-1 text-charcoal text-clamp-2" title={event.message ?? copy.empty}>{event.message ?? copy.empty}</p>
              </div>
              <small className="text-[12px] leading-4 text-charcoal">{event.source ?? copy.sourceSystem} {event.attempt ? `${copy.attempt} ${event.attempt}` : ""}</small>
            </li>
          ))}
          {orderedEvents.length === 0 ? <li className="px-4 py-5 text-[13px] text-charcoal">{copy.noEvents}</li> : null}
        </ol>
      </CardContent>
    </Card>
  );
}

function buildPhaseSpans(events: RunEvent[]): PhaseSpan[] {
  const observedPhases = events.map((event) => String(event.phase ?? "")).filter(Boolean);
  const phaseFlow = [...standardPhaseFlow];
  for (const phase of observedPhases) {
    if (!phaseFlow.includes(phase)) phaseFlow.push(phase);
  }

  const eventTimes = events.map((event) => parseDate(event.created_at)).filter((time): time is number => time !== null);
  const firstOverall = eventTimes[0] ?? 0;
  const lastObservedIndex = Math.max(
    -1,
    ...phaseFlow.map((phase, index) => (events.some((event) => event.phase === phase) ? index : -1))
  );

  return phaseFlow.map((phase, index) => {
    const phaseEvents = events.filter((event) => event.phase === phase);
    const phaseTimes = phaseEvents.map((event) => parseDate(event.created_at)).filter((time): time is number => time !== null);
    const firstTime = phaseTimes[0] ?? firstOverall;
    const lastTime = phaseTimes[phaseTimes.length - 1] ?? firstTime;
    const hasFailure = phaseEvents.some(isFailureEvent);
    const eventCount = phaseEvents.length;
    const status = hasFailure ? "failed" : eventCount === 0 ? "pending" : index < lastObservedIndex || phase === "Completed" ? "complete" : "active";
    const sources = Array.from(new Set(phaseEvents.map((event) => event.source).filter(Boolean) as string[]));
    return {
      phase,
      eventCount,
      status,
      sources,
      durationMs: eventCount > 0 ? Math.max(0, lastTime - firstTime) : 0
    };
  });
}

function selectWithKeyboard(
  event: KeyboardEvent<HTMLTableRowElement>,
  span: PhaseSpan,
  onSelectSpan: RunTimelineProps["onSelectSpan"]
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
  if (status === "failed") return "bg-forest-ink text-linen-white";
  if (status === "active") return "bg-cobalt-surface text-paper";
  if (status === "complete") return "bg-mist-blue text-forest-ink";
  return "border border-hairline-gray bg-linen-white text-graphite";
}

function durationBarClassName(status: PhaseSpan["status"]): string {
  if (status === "failed") return "bg-forest-ink";
  if (status === "pending") return "bg-hairline-gray";
  return "bg-electric-blue";
}

function durationWidth(durationMs: number, longestDurationMs: number): number {
  if (durationMs <= 0) return 1;
  return clamp((durationMs / longestDurationMs) * 100, 4, 100);
}

function totalDuration(spans: PhaseSpan[]): number {
  return spans.reduce((longest, span) => Math.max(longest, span.durationMs), 0);
}

function isFailureEvent(event: RunEvent): boolean {
  const phase = String(event.phase ?? "").toLowerCase();
  const type = String(event.event_type ?? event.eventType ?? "").toLowerCase();
  return phase.includes("fail") || phase.includes("cancel") || type.includes("failed") || type.includes("error") || type.includes("blocked") || type.includes("cancel");
}

function formatDate(value: string | undefined, locale: Locale, copy: AdminCopy): string {
  if (!value) return copy.empty;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(time);
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
