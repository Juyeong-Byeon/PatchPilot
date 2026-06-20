import { useEffect, useMemo, useRef, useState } from "react";
import { Ban, ExternalLink, RotateCcw, Undo2, X } from "lucide-react";
import type { Artifact, JobRecord, LogLine, RunEvent } from "../api.js";
import { translateState, type AdminCopy, type Locale } from "../i18n.js";
import { LogViewer } from "./LogViewer.js";
import { RunStepGraph } from "./RunStepGraph.js";
import { RunTimeline, type SpanSelection } from "./RunTimeline.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";

interface JobDetailProps {
  job: JobRecord | null;
  events: RunEvent[];
  logs: LogLine[];
  artifacts: Artifact[];
  isLoading: boolean;
  actionState: string;
  nowMs: number;
  copy: AdminCopy;
  locale: Locale;
  onBack?(): void;
  onRefresh?(): void;
  onRetry(): void;
  onCancel(): void;
}

export function JobDetail({
  job,
  events,
  logs,
  artifacts,
  isLoading,
  actionState,
  nowMs,
  copy,
  locale,
  onBack,
  onRefresh,
  onRetry,
  onCancel
}: JobDetailProps) {
  const [selectedSpan, setSelectedSpan] = useState<SpanSelection | null>(null);
  const lastAutoFocusedKey = useRef<string>("");
  const currentAttempt = useMemo(() => resolveCurrentAttempt(job, events), [events, job]);
  const currentRunId = useMemo(() => resolveCurrentRunId(events, currentAttempt), [currentAttempt, events]);
  const currentEvents = useMemo(() => filterEventsForCurrentRun(events, currentAttempt, currentRunId), [currentAttempt, currentRunId, events]);
  const currentLogs = useMemo(() => filterRunScopedRecords(logs, currentRunId), [currentRunId, logs]);
  const currentArtifacts = useMemo(() => filterRunScopedRecords(artifacts, currentRunId), [artifacts, currentRunId]);
  const runningPhase = useMemo(() => resolveRunningPhase(job), [job]);
  const selectedContext = useMemo(() => buildStepContext(selectedSpan, currentEvents, locale), [currentEvents, locale, selectedSpan]);
  const diagnosticLogs = useMemo(() => filterLogsForContext(currentLogs, selectedContext), [currentLogs, selectedContext]);
  const diagnosticArtifacts = useMemo(() => filterArtifactsForContext(currentArtifacts, selectedContext), [currentArtifacts, selectedContext]);

  useEffect(() => {
    if (!job || !runningPhase) return;

    const focusKey = `${job.id}:${currentRunId ?? currentAttempt ?? ""}:${runningPhase}`;
    if (lastAutoFocusedKey.current === focusKey) return;

    lastAutoFocusedKey.current = focusKey;
    setSelectedSpan({ phase: runningPhase });
  }, [currentAttempt, currentRunId, job, runningPhase]);

  if (!job) {
    return (
      <Card className="min-h-[176px]">
        <CardHeader className="items-start">
          <CardTitle>{copy.jobDetail}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-[13px] leading-5 text-charcoal">{isLoading ? copy.loadingDetail : copy.selectJob}</p>
        </CardContent>
      </Card>
    );
  }
  const terminal = isTerminalPhase(job.phase);
  const retryDisabled = Boolean(actionState) || job.phase !== "Failed";
  const cancelDisabled = Boolean(actionState) || terminal;

  return (
    <section className="grid gap-4">
      <Card className="bg-linen-white">
        <CardContent className="grid gap-4">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
            <div className="min-w-0">
              <p className="truncate font-mono text-[12px] leading-4 text-graphite" title={job.id}>{job.id}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge>{translateState(job.phase, locale)}</Badge>
                <Badge variant={String(job.outcome).includes("Failed") ? "dark" : "outline"}>{translateState(job.outcome, locale)}</Badge>
              </div>
              <h2 className="mt-3 font-sans text-[22px] font-semibold leading-[1.25] text-forest-ink">
                {stringValue(job.repository, copy)}
              </h2>
              <p className="mt-1 text-[13px] leading-5 text-charcoal">
                {stringValue(job.target_branch ?? job.targetBranch, copy)} · {stringValue(job.work_branch ?? job.workBranch, copy)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {onRefresh ? (
                <Button type="button" variant="outline" size="icon" aria-label={copy.refresh} title={copy.refresh} disabled={isLoading} onClick={onRefresh}>
                  <RotateCcw data-icon aria-hidden="true" className={isLoading ? "animate-spin" : ""} strokeWidth={2.2} />
                </Button>
              ) : null}
              {job.pr_url ? (
                <a
                  aria-label={copy.openPr}
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-hairline-gray bg-linen-white text-cobalt-surface no-underline shadow-sm shadow-midnight-ink/5 transition-all duration-150 hover:-translate-y-0.5 hover:border-electric-blue hover:bg-mist-blue hover:shadow-md hover:shadow-electric-blue/10"
                  href={job.pr_url}
                  rel="noreferrer"
                  title={copy.openPr}
                  target="_blank"
                >
                  <ExternalLink aria-hidden="true" size={16} strokeWidth={2.2} />
                </a>
              ) : null}
              <Button
                type="button"
                size="icon"
                aria-label={actionState === "retry" ? copy.retrying : copy.retry}
                title={actionState === "retry" ? copy.retrying : copy.retry}
                disabled={retryDisabled}
                onClick={onRetry}
              >
                <Undo2 data-icon aria-hidden="true" strokeWidth={2.2} />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={actionState === "cancel" ? copy.cancelling : copy.cancel}
                title={actionState === "cancel" ? copy.cancelling : copy.cancel}
                disabled={cancelDisabled}
                onClick={onCancel}
              >
                <Ban data-icon aria-hidden="true" strokeWidth={2.2} />
              </Button>
            </div>
          </div>

          {(job.failure_reason || job.next_action) ? (
            <section className="status-glow-failed rounded-xl border border-danger bg-danger-wash px-4 py-3">
              <p className="text-[12px] leading-4 text-charcoal">{copy.failureSummary}</p>
              {job.failure_reason ? <p className="mt-2 break-words text-[13px] leading-5 text-danger">{job.failure_reason}</p> : null}
              {job.next_action ? (
                <p className="mt-2 break-words text-[13px] leading-5 text-true-black">
                  <span className="text-charcoal">{copy.nextAction}: </span>
                  {job.next_action}
                </p>
              ) : null}
            </section>
          ) : null}

          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Fact label={copy.priority} value={stringValue(job.priority, copy)} />
            <Fact label={copy.attempt} value={stringValue(job.attempt, copy)} />
            <Fact label={copy.updated} value={formatDate(job.updated_at, locale, copy)} />
            <Fact label={copy.failure} value={stringValue(job.failure_category, copy)} tone="danger" />
          </dl>
        </CardContent>
      </Card>

      <RunStepGraph
        events={currentEvents}
        currentPhase={job.phase}
        copy={copy}
        locale={locale}
        selectedStep={selectedSpan}
        onSelectStep={setSelectedSpan}
      />
      <Card>
        <CardHeader>
          <CardTitle>{copy.runDiagnostics}</CardTitle>
          {selectedContext ? (
            <Button type="button" variant="ghost" size="icon" aria-label={copy.clear} title={copy.clear} onClick={() => setSelectedSpan(null)}>
              <X data-icon aria-hidden="true" strokeWidth={2.2} />
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-4">
          <RunTimeline
            events={currentEvents}
            currentPhase={job.phase}
            nowMs={nowMs}
            copy={copy}
            locale={locale}
            selectedSpan={selectedSpan}
            onSelectSpan={setSelectedSpan}
            variant="embedded"
          />
          <LogViewer
            logs={diagnosticLogs}
            totalCount={currentLogs.length}
            copy={copy}
            variant="embedded"
          />
          <ArtifactPanel
            artifacts={diagnosticArtifacts}
            totalCount={currentArtifacts.length}
            copy={copy}
            locale={locale}
            variant="embedded"
          />
        </CardContent>
      </Card>
    </section>
  );
}

function ArtifactPanel({
  artifacts,
  totalCount,
  copy,
  locale,
  variant = "card"
}: {
  artifacts: Artifact[];
  totalCount?: number;
  copy: AdminCopy;
  locale: Locale;
  variant?: "card" | "embedded";
}) {
  const content = (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-hairline-gray p-4">
        <div>
          <CardTitle>{copy.artifacts}</CardTitle>
          <span className="text-xs text-charcoal">{artifacts.length}/{totalCount ?? artifacts.length}</span>
        </div>
      </div>
      <div className="grid gap-3 p-4">
        {artifacts.map((artifact, index) => (
          <article className="overflow-hidden rounded-xl border border-hairline-gray bg-linen-white" key={String(artifact.id ?? `${artifact.kind}-${index}`)}>
            <header className="grid gap-2 border-b border-hairline-gray bg-linen px-4 py-3 text-[12px] leading-4 md:grid-cols-[160px_minmax(0,1fr)_150px]">
              <strong className="font-medium text-forest-ink">{artifact.kind ?? "artifact"}</strong>
              <span className="min-w-0 break-all font-mono text-graphite" title={artifact.path ?? copy.inlineContent}>
                {artifact.path ?? copy.inlineContent}
              </span>
              <time className="text-charcoal md:text-right">{formatDate(artifact.created_at, locale, copy)}</time>
            </header>
            {artifact.content ? (
              <pre className="terminal-surface m-0 max-h-[280px] overflow-auto p-4 text-[12px] leading-5 whitespace-pre-wrap break-all text-true-black">
                {formatJson(artifact.content)}
              </pre>
            ) : null}
          </article>
        ))}
        {artifacts.length === 0 ? <p className="px-1 py-4 text-[13px] text-charcoal">{copy.noArtifacts}</p> : null}
      </div>
    </>
  );

  if (variant === "embedded") {
    return (
      <section className="surface-card-soft rounded-xl border border-hairline-gray bg-linen-white" aria-label={copy.artifacts}>
        {content}
      </section>
    );
  }

  return (
    <Card>
      {content}
    </Card>
  );
}

interface StepContext {
  phase: string;
  source?: string;
  sources: string[];
  startMs: number | null;
  endMs: number | null;
  label: string;
}

function resolveCurrentAttempt(job: JobRecord | null, events: RunEvent[]): number | null {
  const jobAttempt = parseAttempt(job?.attempt);
  if (jobAttempt !== null) return jobAttempt;

  const attempts = events.map((event) => parseAttempt(event.attempt)).filter((attempt): attempt is number => attempt !== null);
  return attempts.length > 0 ? Math.max(...attempts) : null;
}

function resolveCurrentRunId(events: RunEvent[], currentAttempt: number | null): string | null {
  const orderedEvents = [...events].sort((left, right) => {
    const leftTime = parseTime(left.created_at);
    const rightTime = parseTime(right.created_at);
    return (leftTime ?? 0) - (rightTime ?? 0);
  });
  const currentRunEvent = [...orderedEvents].reverse().find((event) => {
    const runId = stringOrNull(event.run_id);
    if (!runId) return false;
    return currentAttempt === null || parseAttempt(event.attempt) === currentAttempt;
  });

  return stringOrNull(currentRunEvent?.run_id);
}

function filterEventsForCurrentRun(events: RunEvent[], currentAttempt: number | null, currentRunId: string | null): RunEvent[] {
  if (currentAttempt === null && !currentRunId) return events;

  const filtered = events.filter((event) => {
    const eventRunId = stringOrNull(event.run_id);
    const eventAttempt = parseAttempt(event.attempt);

    if (currentRunId && eventRunId === currentRunId) return true;
    if (currentAttempt !== null && eventAttempt === currentAttempt) return true;
    return isJobLevelQueueEvent(event);
  });

  return filtered.length > 0 ? filtered : events;
}

function filterRunScopedRecords<T extends { run_id?: string | null }>(records: T[], currentRunId: string | null): T[] {
  if (!currentRunId) return records;

  const filtered = records.filter((record) => {
    const runId = stringOrNull(record.run_id);
    return !runId || runId === currentRunId;
  });

  return filtered.length > 0 ? filtered : records;
}

function isJobLevelQueueEvent(event: RunEvent): boolean {
  if (stringOrNull(event.run_id) || parseAttempt(event.attempt) !== null) return false;
  const phase = String(event.phase ?? "").toLowerCase();
  const type = String(event.event_type ?? event.eventType ?? "").toLowerCase();
  return phase === "queued" || type.includes("enqueued") || type.includes("retry");
}

function parseAttempt(value: unknown): number | null {
  const attempt = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(attempt) && attempt > 0 ? attempt : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resolveRunningPhase(job: JobRecord | null): string | null {
  const phase = stringOrNull(job?.phase);
  if (!phase || isTerminalPhase(phase)) return null;
  return phase;
}

function buildStepContext(selection: SpanSelection | null, events: RunEvent[], locale: Locale): StepContext | null {
  if (!selection) return null;
  const orderedEvents = [...events].sort((left, right) => {
    const leftTime = parseTime(left.created_at);
    const rightTime = parseTime(right.created_at);
    return (leftTime ?? 0) - (rightTime ?? 0);
  });
  const phaseEvents = orderedEvents.filter((event) => event.phase === selection.phase);
  const sources = Array.from(new Set(phaseEvents.map((event) => event.source).filter(Boolean) as string[]));
  const phaseTimes = phaseEvents.map((event) => parseTime(event.created_at)).filter((time): time is number => time !== null);
  const startMs = phaseTimes[0] ?? null;
  const lastPhaseMs = phaseTimes[phaseTimes.length - 1] ?? startMs;
  const nextEvent = lastPhaseMs === null
    ? undefined
    : orderedEvents.find((event) => {
        const time = parseTime(event.created_at);
        return time !== null && time > lastPhaseMs && event.phase !== selection.phase;
      });
  const endMs = nextEvent ? parseTime(nextEvent.created_at) : null;
  const label = selection.source
    ? `${translateState(selection.phase, locale)} · ${selection.source}`
    : translateState(selection.phase, locale);

  return {
    phase: selection.phase,
    source: selection.source,
    sources,
    startMs,
    endMs,
    label
  };
}

function filterLogsForContext(logs: LogLine[], context: StepContext | null): LogLine[] {
  if (!context) return logs;
  const direct = context.source ? logs.filter((line) => line.source === context.source) : [];
  if (direct.length > 0) return direct;

  const timed = logs.filter((line) => isWithinContext(line.created_at, context));
  if (timed.length > 0) return timed;

  return context.sources.length > 0
    ? logs.filter((line) => Boolean(line.source && context.sources.includes(line.source)))
    : [];
}

function filterArtifactsForContext(artifacts: Artifact[], context: StepContext | null): Artifact[] {
  if (!context) return artifacts;
  const mapped = artifacts.filter((artifact) => artifactMatchesPhase(artifact, context.phase));
  if (mapped.length > 0) return mapped;
  return artifacts.filter((artifact) => !hasKnownArtifactPhase(artifact) && isWithinContext(artifact.created_at, context));
}

function artifactMatchesPhase(artifact: Artifact, phase: string): boolean {
  const kind = String(artifact.kind ?? "").toLowerCase();
  if (!kind) return false;
  if (kind.includes("policy")) return phase === "PolicyChecking";
  if (kind.includes("agent-result") || kind.includes("result")) return phase === "Completed";
  if (kind.includes("pr") || kind.includes("publish")) return phase === "Publishing";
  if (kind.includes("ticket") || kind.includes("context") || kind.includes("input")) return phase === "Queued" || phase === "Planning";
  if (kind.includes("runner") || kind.includes("gstack")) return phase === "Implementing";
  return false;
}

function hasKnownArtifactPhase(artifact: Artifact): boolean {
  const kind = String(artifact.kind ?? "").toLowerCase();
  return Boolean(
    kind.includes("policy") ||
    kind.includes("agent-result") ||
    kind.includes("result") ||
    kind.includes("pr") ||
    kind.includes("publish") ||
    kind.includes("ticket") ||
    kind.includes("context") ||
    kind.includes("input") ||
    kind.includes("runner") ||
    kind.includes("gstack")
  );
}

function isWithinContext(value: string | undefined, context: StepContext): boolean {
  const time = parseTime(value);
  if (time === null || context.startMs === null) return false;
  if (time < context.startMs) return false;
  return context.endMs === null ? true : time <= context.endMs;
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="min-w-0 rounded-xl border border-hairline-gray bg-linen-white p-3">
      <dt className="mb-2 text-[12px] leading-4 text-charcoal">{label}</dt>
      <dd className="m-0 break-words text-[13px] leading-5 text-true-black">
        {tone === "danger" && value !== "-" ? <Badge variant="dark">{value}</Badge> : value}
      </dd>
    </div>
  );
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function stringValue(value: unknown, copy: AdminCopy): string {
  if (value === null || value === undefined || value === "") return copy.empty;
  return String(value);
}

function isTerminalPhase(phase: unknown): boolean {
  return phase === "Completed" || phase === "Failed" || phase === "Cancelled" || phase === "CancelFailed";
}

function formatDate(value: string | undefined, locale: Locale, copy: AdminCopy): string {
  if (!value) return copy.empty;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(time);
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
