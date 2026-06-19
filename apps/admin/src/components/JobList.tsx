import { useMemo, useState } from "react";
import type { JobRecord } from "../api.js";

interface JobListProps {
  jobs: JobRecord[];
  selectedJobId: string;
  isLoading: boolean;
  onSelectJob(jobId: string): void;
}

export function JobList({ jobs, selectedJobId, isLoading, onSelectJob }: JobListProps) {
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
    <section className="panel job-list" aria-label="Jobs">
      <div className="panel-header">
        <div>
          <h2>Jobs</h2>
          <span>{isLoading ? "Loading" : `${filteredJobs.length}/${jobs.length}`}</span>
        </div>
        <input
          aria-label="Filter jobs"
          value={query}
          placeholder="Filter job, repo, branch"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Outcome</th>
              <th>Phase</th>
              <th>Repo</th>
              <th>Branch</th>
              <th>Runtime</th>
              <th>Last Event</th>
              <th>PR</th>
            </tr>
          </thead>
          <tbody>
            {filteredJobs.map((job) => {
              const selected = job.id === selectedJobId;
              return (
                <tr key={job.id} className={selected ? "selected-row" : undefined}>
                  <td>
                    <button className="link-button mono" type="button" onClick={() => onSelectJob(job.id)}>
                      {job.id}
                    </button>
                  </td>
                  <td>
                    <StatusPill value={job.outcome ?? "Unknown"} />
                  </td>
                  <td>{job.phase ?? "-"}</td>
                  <td>{job.repository ?? "-"}</td>
                  <td>{getValue(job, "target_branch", "targetBranch") ?? "-"}</td>
                  <td>{runtime(job)}</td>
                  <td>{job.last_event ?? getValue(job, "lastEvent") ?? "-"}</td>
                  <td>{job.pr_url ? <a href={job.pr_url}>Open</a> : "-"}</td>
                </tr>
              );
            })}
            {filteredJobs.length === 0 ? (
              <tr>
                <td colSpan={8} className="empty-cell">
                  No jobs match the current filter.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StatusPill({ value }: { value: string }) {
  return <span className={`pill ${value.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{value}</span>;
}

function getValue(job: JobRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = job[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function runtime(job: JobRecord): string {
  const started = parseTime(getValue(job, "started_at", "created_at"));
  const finished = parseTime(getValue(job, "finished_at", "updated_at"));
  if (!started || !finished) return "-";
  const seconds = Math.max(0, Math.round((finished - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}
