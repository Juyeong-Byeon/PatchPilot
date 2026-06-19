import { useMemo, type CSSProperties } from "react";
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
  latestMessage: string;
  sources: string[];
  durationMs: number;
  offsetPct: number;
  widthPct: number;
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
              <p className="m-0 text-[12px] leading-4 text-charcoal">{copy.traceFlowSummary}</p>
            </div>
            <span className="text-[12px] leading-4 text-charcoal">{formatDuration(totalDuration(spans))}</span>
          </div>

          <div className="grid gap-2">
            {spans.map((span) => {
              const selected = selectedSpan?.phase === span.phase && (!selectedSpan.source || span.sources.includes(selectedSpan.source));
              return (
                <button
                  className={`grid gap-3 rounded-lg px-3 py-2 text-left text-[12px] md:grid-cols-[116px_112px_minmax(0,1fr)_96px] md:items-center ${selected ? "bg-linen-white ring-1 ring-forest-ink" : "hover:bg-linen-white"}`}
                  key={span.phase}
                  type="button"
                  onClick={() => onSelectSpan?.({ phase: span.phase, source: span.sources[0] })}
                >
                  <div className="min-w-0">
                    <p className="m-0 text-[13px] font-medium leading-5 text-true-black">{translateState(span.phase, locale)}</p>
                    <span className="text-charcoal">{statusLabel(span.status, copy)}</span>
                  </div>
                  <div className="min-w-0">
                    <p className="m-0 text-[12px] leading-4 text-charcoal">{copy.service}</p>
                    <span className="block truncate text-forest-ink" title={span.sources.join(", ") || copy.sourceSystem}>
                      {span.sources.join(", ") || copy.sourceSystem}
                    </span>
                  </div>
                  <div className="grid min-w-0 gap-1">
                    <div className="relative h-2 overflow-hidden rounded-full bg-linen">
                      <div
                        className={`absolute top-0 bottom-0 min-w-[20px] rounded-full ${spanClassName(span.status)}`}
                        style={spanStyle(span)}
                      />
                    </div>
                    <p className="m-0 text-[12px] leading-4 text-charcoal text-clamp-1" title={span.latestMessage || copy.spanNoEvents}>
                      {span.latestMessage || copy.spanNoEvents}
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-charcoal md:justify-end">
                    <span>{span.eventCount > 0 ? copy.spanEvents(span.eventCount) : copy.spanNoEvents}</span>
                    <span className="font-mono">{formatDuration(span.durationMs)}</span>
                  </div>
                </button>
            );
            })}
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
  const lastOverall = eventTimes[eventTimes.length - 1] ?? firstOverall;
  const overallDuration = Math.max(1, lastOverall - firstOverall);
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
    const latestMessage = [...phaseEvents].reverse().find((event) => event.message)?.message ?? "";
    const sources = Array.from(new Set(phaseEvents.map((event) => event.source).filter(Boolean) as string[]));
    const offsetPct = eventCount > 0 ? clamp(((firstTime - firstOverall) / overallDuration) * 100, 0, 92) : 0;
    const widthPct = eventCount > 0 ? clamp((Math.max(1, lastTime - firstTime) / overallDuration) * 100, 8, 100 - offsetPct) : 100;

    return {
      phase,
      eventCount,
      status,
      latestMessage,
      sources,
      durationMs: eventCount > 0 ? Math.max(0, lastTime - firstTime) : 0,
      offsetPct,
      widthPct
    };
  });
}

function statusLabel(status: PhaseSpan["status"], copy: AdminCopy): string {
  if (status === "failed") return copy.spanFailurePoint;
  if (status === "active") return copy.spanActive;
  if (status === "complete") return copy.spanComplete;
  return copy.spanPending;
}

function spanClassName(status: PhaseSpan["status"]): string {
  if (status === "failed") return "bg-forest-ink text-linen-white";
  if (status === "active") return "bg-sage-wash text-forest-ink";
  if (status === "complete") return "bg-mint-veil text-forest-ink";
  return "border border-hairline-gray bg-linen-white text-graphite";
}

function spanStyle(span: PhaseSpan): CSSProperties {
  return {
    left: `${span.offsetPct}%`,
    width: `${span.widthPct}%`
  };
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
