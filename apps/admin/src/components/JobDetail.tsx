import { useState } from "react";
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
  copy: AdminCopy;
  locale: Locale;
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
  copy,
  locale,
  onRetry,
  onCancel
}: JobDetailProps) {
  const [selectedSpan, setSelectedSpan] = useState<SpanSelection | null>(null);

  if (!job) {
    return (
      <Card className="min-h-[176px]">
        <CardHeader>
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
              <p className="font-mono text-[12px] leading-4 text-graphite">{job.id}</p>
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
              <Button type="button" disabled={retryDisabled} onClick={onRetry}>
                {actionState === "retry" ? copy.retrying : copy.retry}
              </Button>
              <Button type="button" variant="outline" disabled={cancelDisabled} onClick={onCancel}>
                {actionState === "cancel" ? copy.cancelling : copy.cancel}
              </Button>
            </div>
          </div>

          {(job.failure_reason || job.next_action) ? (
            <section className="rounded-xl border border-forest-ink bg-linen px-4 py-3">
              <p className="text-[12px] leading-4 text-charcoal">{copy.failureSummary}</p>
              {job.failure_reason ? <p className="mt-2 text-[13px] leading-5 text-forest-ink">{job.failure_reason}</p> : null}
              {job.next_action ? (
                <p className="mt-2 text-[13px] leading-5 text-true-black">
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
        events={events}
        currentPhase={job.phase}
        copy={copy}
        locale={locale}
        selectedStep={selectedSpan}
        onSelectStep={setSelectedSpan}
      />
      <RunTimeline events={events} copy={copy} locale={locale} selectedSpan={selectedSpan} onSelectSpan={setSelectedSpan} />
      <LogViewer logs={logs} copy={copy} highlightSource={selectedSpan?.source} onClearHighlight={() => setSelectedSpan(null)} />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{copy.artifacts}</CardTitle>
            <span className="text-xs text-charcoal">{artifacts.length}</span>
          </div>
        </CardHeader>
        <CardContent className="grid max-h-[360px] gap-3 overflow-auto">
          {artifacts.map((artifact, index) => (
            <article className="rounded-xl border border-hairline-gray bg-linen p-4" key={String(artifact.id ?? `${artifact.kind}-${index}`)}>
              <header className="flex justify-between gap-3 text-xs">
                <strong className="font-medium text-forest-ink">{artifact.kind ?? "artifact"}</strong>
                <span className="text-charcoal">{formatDate(artifact.created_at, locale, copy)}</span>
              </header>
              <p className="my-2 font-mono text-[12px] leading-4 text-graphite">{artifact.path ?? copy.inlineContent}</p>
              {artifact.content ? <pre className="max-h-[180px] overflow-auto rounded-lg bg-forest-ink p-3 text-xs leading-normal text-linen-white">{formatJson(artifact.content)}</pre> : null}
            </article>
          ))}
          {artifacts.length === 0 ? <p className="px-2 py-4 text-[13px] text-charcoal">{copy.noArtifacts}</p> : null}
        </CardContent>
      </Card>
    </section>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="min-w-0 rounded-xl border border-hairline-gray bg-linen p-3">
      <dt className="mb-2 text-[12px] leading-4 text-charcoal">{label}</dt>
      <dd className="m-0 text-[13px] leading-5 text-true-black [overflow-wrap:anywhere]">
        {tone === "danger" && value !== "-" ? <Badge variant="dark">{value}</Badge> : value}
      </dd>
    </div>
  );
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
