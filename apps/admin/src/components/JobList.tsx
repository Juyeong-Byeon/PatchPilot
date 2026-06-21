import { useMemo, useState, type KeyboardEvent } from "react";
import { ArrowRight, Clock, LoaderCircle, Search } from "lucide-react";
import type { JobRecord } from "../api.js";
import { executorModeLabel, translateState, type AdminCopy, type Locale } from "../i18n.js";
import { cn } from "../lib/utils.js";
import { normalizeExecutorMode, readExecutorMode } from "../lib/evidence.js";
import {
  isActiveRunningPhase,
  isQueuedPhase,
  matchesStatusFilter,
  resolvePrimaryStatus,
  statusBadgeVariant,
  type StatusFilter,
} from "../lib/status.js";
import { useMediaQuery } from "../lib/use-media-query.js";
import { Badge } from "./ui/badge.js";
import { Card, CardHeader, CardTitle } from "./ui/card.js";
import { Input } from "./ui/input.js";

// Tailwind's `md` breakpoint is 768px. Below it we mount the stacked-card layout
// instead of the wide min-w-[1020px] table so narrow viewports never need to
// scroll sideways.
const NARROW_QUERY = "(max-width: 767.98px)";

interface JobListProps {
  jobs: JobRecord[];
  selectedJobId: string;
  isLoading: boolean;
  copy: AdminCopy;
  locale: Locale;
  statusFilter?: StatusFilter;
  onOpenJob(jobId: string): void;
}

const rowColumns = "grid-cols-[136px_300px_minmax(220px,1fr)_154px_56px]";

export function JobList({
  jobs,
  selectedJobId,
  isLoading,
  copy,
  locale,
  statusFilter = "all",
  onOpenJob,
}: JobListProps) {
  const [query, setQuery] = useState("");
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const filteredJobs = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return jobs.filter((job) => {
      if (!matchesStatusFilter(job, statusFilter)) return false;
      if (!normalized) return true;
      return [job.id, job.repository, getValue(job, "target_branch", "targetBranch"), job.phase, job.outcome]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalized);
    });
  }, [jobs, query, statusFilter]);

  return (
    <Card aria-label={copy.jobs} className="overflow-hidden">
      <CardHeader className="flex-col items-stretch gap-3 md:flex-row md:items-center">
        <div className="min-w-0">
          <CardTitle>{copy.jobs}</CardTitle>
          <span className="mt-1 block text-[12px] leading-4 text-charcoal">
            {isLoading ? copy.loading : `${filteredJobs.length}/${jobs.length}`}
          </span>
        </div>
        <div className="relative w-full md:w-[280px]">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-graphite"
          />
          <Input
            className="w-full pl-9"
            aria-label={copy.filterJobsLabel}
            value={query}
            placeholder={copy.filterJobsPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </CardHeader>

      {/* Narrow screens: stacked cards. The wide grid table below has a hard
          min-width (1020px) and only makes sense with horizontal room, so under
          `md` we drop it for a vertical card list that needs no sideways scroll.
          Exactly one layout mounts (media-query gated) to keep the a11y tree clean. */}
      {isNarrow ? (
        <ol className="m-0 grid list-none gap-2 p-3" aria-label={copy.jobs} aria-busy={isLoading && jobs.length === 0}>
          {isLoading && jobs.length === 0 ? <JobCardSkeleton /> : null}
          {filteredJobs.map((job) => (
            <li key={job.id}>
              <JobCard
                job={job}
                selected={job.id === selectedJobId}
                copy={copy}
                locale={locale}
                onOpenJob={onOpenJob}
              />
            </li>
          ))}
          {filteredJobs.length === 0 && !(isLoading && jobs.length === 0) ? (
            <li className="px-2 py-8 text-center text-[13px] text-charcoal">{copy.noJobMatches}</li>
          ) : null}
        </ol>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[1020px]">
            <div
              className={cn(
                "sticky top-0 z-10 grid border-b border-hairline-gray bg-linen-white/95 px-4 py-2 text-[12px] font-medium leading-4 text-charcoal backdrop-blur",
                rowColumns,
              )}
            >
              <span>{copy.tableUpdated}</span>
              <span>{copy.tableJob}</span>
              <span>{copy.tableRepo}</span>
              <span>{copy.tableOutcome}</span>
              <span>{copy.tableAction}</span>
            </div>
            <ol
              className="m-0 max-h-[calc(100vh-292px)] list-none overflow-auto p-0"
              aria-busy={isLoading && jobs.length === 0}
            >
              {isLoading && jobs.length === 0 ? <JobListSkeleton /> : null}
              {filteredJobs.map((job) => {
                const selected = job.id === selectedJobId;
                const active = isActiveRunningJob(job);
                const status = getPrimaryStatus(job, locale, copy);
                const repo = compactText(job.repository, copy, 120);
                const jobUuid = jobUuidValue(job.id, copy);

                return (
                  <li key={job.id}>
                    <button
                      aria-current={selected ? "page" : undefined}
                      data-state={active ? "running" : isQueuedPhase(job.phase) ? "queued" : undefined}
                      className={cn(
                        "interactive-row group grid w-full border-b border-l-4 border-hairline-gray px-4 py-3 text-left text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-electric-blue/25",
                        rowColumns,
                        selected
                          ? "border-l-cobalt-surface bg-mist-blue text-true-black shadow-inner"
                          : active
                            ? "border-l-cobalt-surface bg-mint-veil text-true-black shadow-[inset_4px_0_0_rgba(18,126,227,0.18),0_8px_24px_rgba(18,126,227,0.10)]"
                            : "border-l-transparent bg-linen-white text-true-black hover:border-l-electric-blue hover:bg-mist-blue",
                      )}
                      type="button"
                      onClick={() => onOpenJob(job.id)}
                      onKeyDown={(event) => openWithKeyboard(event, job.id, onOpenJob)}
                    >
                      <span className="min-w-0 pr-4 text-[12px] leading-4 text-charcoal">
                        {formatDate(getValue(job, "updated_at", "created_at"), locale, copy)}
                      </span>
                      <span className="min-w-0 pr-4">
                        <span
                          className="block truncate font-mono text-[12px] leading-5 text-cobalt-surface"
                          title={job.id}
                        >
                          {jobUuid}
                        </span>
                      </span>
                      <span className="min-w-0 pr-4">
                        <span className="block truncate font-medium text-true-black" title={job.repository ?? ""}>
                          {repo}
                        </span>
                      </span>
                      <span className="min-w-0 pr-4">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <StatusIndicator job={job} copy={copy} />
                          <StatusPill value={status.value} label={status.label} />
                          <ExecutorModePill job={job} copy={copy} />
                        </span>
                      </span>
                      <span className="flex min-w-0 items-start">
                        <span
                          className="inline-flex size-8 items-center justify-center rounded-lg border border-hairline-gray bg-linen-white text-cobalt-surface shadow-sm transition-all duration-150 group-hover:translate-x-1 group-hover:border-electric-blue group-hover:bg-electric-blue group-hover:text-paper"
                          title={copy.openJobDetail}
                        >
                          <ArrowRight aria-hidden="true" size={16} strokeWidth={2} />
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {filteredJobs.length === 0 ? (
                <li className="px-5 py-8 text-center text-[13px] text-charcoal">{copy.noJobMatches}</li>
              ) : null}
            </ol>
          </div>
        </div>
      )}
    </Card>
  );
}

// Stacked-card form of a job row for narrow viewports. Carries the same status
// indicator, pills, and open affordance as the wide table row.
function JobCard({
  job,
  selected,
  copy,
  locale,
  onOpenJob,
}: {
  job: JobRecord;
  selected: boolean;
  copy: AdminCopy;
  locale: Locale;
  onOpenJob(jobId: string): void;
}) {
  const active = isActiveRunningJob(job);
  const status = getPrimaryStatus(job, locale, copy);
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      data-state={active ? "running" : isQueuedPhase(job.phase) ? "queued" : undefined}
      className={cn(
        "interactive-card grid w-full gap-2 rounded-xl border border-l-4 border-hairline-gray p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-electric-blue/25",
        selected
          ? "border-l-cobalt-surface bg-mist-blue"
          : active
            ? "border-l-cobalt-surface bg-mint-veil"
            : "border-l-transparent bg-linen-white",
      )}
      onClick={() => onOpenJob(job.id)}
      onKeyDown={(event) => openWithKeyboard(event, job.id, onOpenJob)}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[12px] leading-5 text-cobalt-surface" title={job.id}>
          {jobUuidValue(job.id, copy)}
        </span>
        <span className="shrink-0 text-[11px] leading-4 text-charcoal">
          {formatDate(getValue(job, "updated_at", "created_at"), locale, copy)}
        </span>
      </div>
      <span className="block truncate text-[13px] font-medium leading-5 text-true-black" title={job.repository ?? ""}>
        {compactText(job.repository, copy, 120)}
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <StatusIndicator job={job} copy={copy} />
        <StatusPill value={status.value} label={status.label} />
        <ExecutorModePill job={job} copy={copy} />
      </span>
    </button>
  );
}

function JobCardSkeleton() {
  return (
    <>
      {[0, 1, 2].map((entry) => (
        <li className="grid gap-2 rounded-xl border border-hairline-gray p-3" key={entry}>
          <span className="shimmer-line h-4 w-2/3 rounded" />
          <span className="shimmer-line h-4 w-1/2 rounded" />
          <span className="shimmer-line h-6 w-24 rounded-full" />
        </li>
      ))}
    </>
  );
}

// One status affordance shared by the table row and the card. Color-independent:
//  - active run → spinning loader + accessible "running" status role
//  - queued     → static clock icon + "queued" label (NOT a spinner), so a job
//    still parked in the queue never reads as actively executing.
function StatusIndicator({ job, copy }: { job: JobRecord; copy: AdminCopy }) {
  if (isActiveRunningJob(job)) {
    return (
      <LoaderCircle
        aria-label={copy.runningJobs}
        className="status-glow-active size-5 shrink-0 animate-spin rounded-full text-cobalt-surface"
        role="status"
        strokeWidth={2.3}
      />
    );
  }
  if (isQueuedPhase(job.phase)) {
    return (
      <Clock aria-label={copy.statusQueued} role="img" className="size-5 shrink-0 text-graphite" strokeWidth={2.3} />
    );
  }
  return null;
}

function JobListSkeleton() {
  return (
    <>
      {[0, 1, 2].map((entry) => (
        <li className="grid border-b border-hairline-gray px-4 py-3" key={entry}>
          <div className={cn("grid items-center gap-4", rowColumns)}>
            <span className="shimmer-line h-4 rounded" />
            <span className="shimmer-line h-4 rounded" />
            <span className="shimmer-line h-4 rounded" />
            <span className="shimmer-line h-6 rounded-full" />
            <span className="shimmer-line size-8 rounded-lg" />
          </div>
        </li>
      ))}
    </>
  );
}

function openWithKeyboard(event: KeyboardEvent<HTMLButtonElement>, jobId: string, onOpenJob: (jobId: string) => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onOpenJob(jobId);
}

function isActiveRunningJob(job: JobRecord): boolean {
  return isActiveRunningPhase(job.phase);
}

function getPrimaryStatus(job: JobRecord, locale: Locale, copy: AdminCopy): { value: string; label: string } {
  // Queued is in the running set but not yet executing: give it its own label
  // ("대기열") and badge token so it never reads as an active run.
  if (isQueuedPhase(job.phase)) {
    return { value: "Queued", label: copy.statusQueued };
  }

  if (isActiveRunningPhase(job.phase)) {
    return { value: "Running", label: formatRunningPhase(job, locale, copy) };
  }

  // Single source of truth shared with JobDetail: collapses the (phase, outcome)
  // pair to one canonical state (e.g. Completed+NeedsReview → "PR 리뷰 대기"), and
  // surfaces an in-flight cancel from the phase instead of a stale "Running".
  const primary = resolvePrimaryStatus(job);
  if (!primary) return { value: copy.unknown, label: copy.unknown };
  return { value: primary, label: translateState(primary, locale) };
}

function formatRunningPhase(job: JobRecord, locale: Locale, copy: AdminCopy): string {
  const phase = translateState(job.phase, locale);
  if (!phase || phase === copy.empty) return copy.runningJobs;
  return locale === "ko" ? `${phase} 중` : phase;
}

function StatusPill({ value, label }: { value: string; label: string }) {
  return (
    <Badge data-testid="job-status-pill" variant={statusBadgeVariant(value)}>
      {label}
    </Badge>
  );
}

// Forward-compat: render the executor/pipeline mode chip only when the backend
// record carries the field (added later by another track). Absent → nothing.
function ExecutorModePill({ job, copy }: { job: JobRecord; copy: AdminCopy }) {
  const mode = readExecutorMode(job);
  if (!mode) return null;
  return (
    <Badge data-testid="job-executor-pill" variant="outline">
      {executorModeLabel(normalizeExecutorMode(mode), mode, copy)}
    </Badge>
  );
}

function getValue(job: JobRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = job[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function jobUuidValue(value: string | undefined, copy: AdminCopy): string {
  if (!value) return copy.empty;
  const uuid = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  return uuid ?? value;
}

function compactText(value: unknown, copy: AdminCopy, maxLength: number): string {
  const text = stringValue(value, copy).replace(/\s+/g, " ").trim();
  if (!text || text === copy.empty) return copy.empty;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function stringValue(value: unknown, copy: AdminCopy): string {
  if (value === null || value === undefined || value === "") return copy.empty;
  return String(value);
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
  }).format(time);
}
