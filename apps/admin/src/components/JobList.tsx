import { useMemo, useState, type KeyboardEvent } from "react";
import { ArrowRight, Search } from "lucide-react";
import type { JobRecord } from "../api.js";
import { translateState, type AdminCopy, type Locale } from "../i18n.js";
import { cn } from "../lib/utils.js";
import { Badge } from "./ui/badge.js";
import { Card, CardHeader, CardTitle } from "./ui/card.js";
import { Input } from "./ui/input.js";

interface JobListProps {
  jobs: JobRecord[];
  selectedJobId: string;
  isLoading: boolean;
  copy: AdminCopy;
  locale: Locale;
  onOpenJob(jobId: string): void;
}

const rowColumns = "grid-cols-[136px_300px_minmax(220px,1fr)_154px_56px]";

export function JobList({ jobs, selectedJobId, isLoading, copy, locale, onOpenJob }: JobListProps) {
  const [query, setQuery] = useState("");
  const filteredJobs = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return jobs;
    return jobs.filter((job) =>
      [job.id, job.repository, getValue(job, "target_branch", "targetBranch"), job.phase, job.outcome]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalized)
    );
  }, [jobs, query]);

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
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-graphite" />
          <Input
            className="w-full pl-9"
            aria-label={copy.filterJobsLabel}
            value={query}
            placeholder={copy.filterJobsPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </CardHeader>

      <div className="overflow-x-auto">
        <div className="min-w-[1020px]">
          <div className={cn("sticky top-0 z-10 grid border-b border-hairline-gray bg-linen-white/95 px-4 py-2 text-[12px] font-medium leading-4 text-charcoal backdrop-blur", rowColumns)}>
            <span>{copy.tableUpdated}</span>
            <span>{copy.tableJob}</span>
            <span>{copy.tableRepo}</span>
            <span>{copy.tableOutcome}</span>
            <span>{copy.tableAction}</span>
          </div>
          <ol className="m-0 max-h-[calc(100vh-292px)] list-none overflow-auto p-0">
            {isLoading && jobs.length === 0 ? <JobListSkeleton /> : null}
            {filteredJobs.map((job) => {
              const selected = job.id === selectedJobId;
              const repo = compactText(job.repository, copy, 120);
              const jobUuid = jobUuidValue(job.id, copy);

              return (
                <li key={job.id}>
                  <button
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "interactive-row group grid w-full border-b border-l-4 border-hairline-gray px-4 py-3 text-left text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-electric-blue/25",
                      rowColumns,
                      selected
                        ? "border-l-cobalt-surface bg-mist-blue text-true-black shadow-inner"
                        : "border-l-transparent bg-linen-white text-true-black hover:border-l-electric-blue hover:bg-mist-blue"
                    )}
                    type="button"
                    onClick={() => onOpenJob(job.id)}
                    onKeyDown={(event) => openWithKeyboard(event, job.id, onOpenJob)}
                  >
                    <span className="min-w-0 pr-4 text-[12px] leading-4 text-charcoal">
                      {formatDate(getValue(job, "updated_at", "created_at"), locale, copy)}
                    </span>
                    <span className="min-w-0 pr-4">
                      <span className="block truncate font-mono text-[12px] leading-5 text-cobalt-surface" title={job.id}>
                        {jobUuid}
                      </span>
                    </span>
                    <span className="min-w-0 pr-4">
                      <span className="block truncate font-medium text-true-black" title={job.repository ?? ""}>
                        {repo}
                      </span>
                    </span>
                    <span className="min-w-0 pr-4">
                      <span className="flex flex-wrap gap-1.5">
                        <StatusPill value={job.outcome ?? copy.unknown} label={translateState(job.outcome, locale)} />
                        <StatusPill value={job.phase ?? copy.unknown} label={translateState(job.phase, locale)} subtle />
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
    </Card>
  );
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

function StatusPill({ value, label, subtle = false }: { value: string; label: string; subtle?: boolean }) {
  const normalized = value.toLowerCase();
  const variant = subtle
    ? "outline"
    : normalized.includes("failed") || normalized.includes("cancel")
      ? "dark"
      : normalized.includes("review") || normalized.includes("queued")
        ? "warning"
        : "default";
  return <Badge variant={variant}>{label}</Badge>;
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
    minute: "2-digit"
  }).format(time);
}
