import { useMemo, useState, type ReactNode } from "react";
import type { JobRecord } from "../api.js";
import { translateState, type AdminCopy, type Locale } from "../i18n.js";
import { Badge } from "./ui/badge.js";
import { Card, CardHeader, CardTitle } from "./ui/card.js";
import { Input } from "./ui/input.js";

interface JobListProps {
  jobs: JobRecord[];
  selectedJobId: string;
  isLoading: boolean;
  copy: AdminCopy;
  locale: Locale;
  onSelectJob(jobId: string): void;
}

export function JobList({ jobs, selectedJobId, isLoading, copy, locale, onSelectJob }: JobListProps) {
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
    <Card aria-label={copy.jobs}>
      <CardHeader className="flex-col items-stretch md:flex-row md:items-center">
        <div>
          <CardTitle>{copy.jobs}</CardTitle>
          <span className="text-[12px] leading-4 text-charcoal">{isLoading ? copy.loading : `${filteredJobs.length}/${jobs.length}`}</span>
        </div>
        <Input
          className="w-full md:w-[280px]"
          aria-label={copy.filterJobsLabel}
          value={query}
          placeholder={copy.filterJobsPlaceholder}
          onChange={(event) => setQuery(event.target.value)}
        />
      </CardHeader>

      <div className="max-h-[calc(100vh-240px)] overflow-auto">
        <table className="w-full table-fixed border-collapse text-left text-[13px]">
          <thead>
            <tr>
              <HeaderCell>{copy.tableOutcome}</HeaderCell>
              <HeaderCell>{copy.tableJob}</HeaderCell>
              <HeaderCell>{copy.tableBranch}</HeaderCell>
              <HeaderCell>{copy.tableRuntime}</HeaderCell>
              <HeaderCell>{copy.tableLastEvent}</HeaderCell>
              <HeaderCell>{copy.tablePr}</HeaderCell>
            </tr>
          </thead>
          <tbody>
            {filteredJobs.map((job) => {
              const selected = job.id === selectedJobId;
              return (
                <tr key={job.id} className={selected ? "border-l-4 border-forest-ink bg-linen text-true-black" : "border-l-4 border-transparent bg-linen-white text-true-black hover:bg-linen"}>
                  <BodyCell>
                    <div className="grid gap-1">
                      <StatusPill value={job.outcome ?? copy.unknown} label={translateState(job.outcome, locale)} />
                      <span className="text-[12px] leading-4 text-charcoal">{translateState(job.phase, locale)}</span>
                    </div>
                  </BodyCell>
                  <BodyCell>
                    <button className="font-mono text-[12px] leading-4 text-forest-ink underline decoration-mist-blue underline-offset-4 hover:text-true-black" type="button" onClick={() => onSelectJob(job.id)}>
                      {job.id}
                    </button>
                    <p className="mt-1 truncate text-[12px] leading-4 text-charcoal">{job.repository ?? copy.empty}</p>
                  </BodyCell>
                  <BodyCell>{getValue(job, "target_branch", "targetBranch") ?? copy.empty}</BodyCell>
                  <BodyCell>{runtime(job, copy)}</BodyCell>
                  <BodyCell>{job.last_event ?? getValue(job, "lastEvent") ?? copy.empty}</BodyCell>
                  <BodyCell>
                    {job.pr_url ? (
                      <a href={job.pr_url}>
                        {copy.openPr}
                      </a>
                    ) : (
                      copy.empty
                    )}
                  </BodyCell>
                </tr>
              );
            })}
            {filteredJobs.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-[13px] text-charcoal">{copy.noJobMatches}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function HeaderCell({ children }: { children: ReactNode }) {
  return <th className="sticky top-0 z-10 border-b border-hairline-gray bg-linen-white px-4 py-2 text-[12px] font-medium text-charcoal">{children}</th>;
}

function BodyCell({ children }: { children: ReactNode }) {
  return <td className="border-b border-hairline-gray px-4 py-3 align-top leading-5 [overflow-wrap:anywhere]">{children}</td>;
}

function StatusPill({ value, label }: { value: string; label: string }) {
  const normalized = value.toLowerCase();
  const variant = normalized.includes("failed") || normalized.includes("cancel") ? "dark" : normalized.includes("review") || normalized.includes("queued") ? "warning" : "default";
  return <Badge variant={variant}>{label}</Badge>;
}

function getValue(job: JobRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = job[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function runtime(job: JobRecord, copy: AdminCopy): string {
  const started = parseTime(getValue(job, "started_at", "created_at"));
  const finished = parseTime(getValue(job, "finished_at", "updated_at"));
  if (!started || !finished) return copy.empty;
  const seconds = Math.max(0, Math.round((finished - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}
