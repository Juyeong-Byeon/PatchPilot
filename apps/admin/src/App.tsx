import { useEffect, useMemo, useState } from "react";
import {
  cancelJob,
  fetchJob,
  fetchJobArtifacts,
  fetchJobEvents,
  fetchJobLogs,
  fetchJobs,
  getStoredAdminToken,
  retryJob,
  storeAdminToken,
  type Artifact,
  type JobRecord,
  type LogLine,
  type RunEvent
} from "./api.js";
import { JobDetail } from "./components/JobDetail.js";
import { JobList } from "./components/JobList.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { adminCopy, getInitialLocale, localeNames, storeLocale, type AdminCopy, type Locale } from "./i18n.js";

interface DetailState {
  job: JobRecord | null;
  events: RunEvent[];
  logs: LogLine[];
  artifacts: Artifact[];
}

type StatusState =
  | { kind: "ready" }
  | { kind: "enterToken" }
  | { kind: "loadedJobs"; count: number }
  | { kind: "refreshFailed" }
  | { kind: "retryQueued"; attempt: number }
  | { kind: "cancelRequested"; phase: string };

const emptyDetail: DetailState = {
  job: null,
  events: [],
  logs: [],
  artifacts: []
};

export default function App() {
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale());
  const copy = adminCopy[locale];
  const [token, setToken] = useState(() => getStoredAdminToken());
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>("");
  const [detail, setDetail] = useState<DetailState>(emptyDetail);
  const [isLoadingJobs, setIsLoadingJobs] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [status, setStatus] = useState<StatusState>(() => (token ? { kind: "ready" } : { kind: "enterToken" }));
  const [error, setError] = useState<string>("");
  const [actionState, setActionState] = useState<string>("");

  const selectedJob = useMemo(
    () => detail.job ?? jobs.find((job) => job.id === selectedJobId) ?? null,
    [detail.job, jobs, selectedJobId]
  );
  const jobStats = useMemo(
    () => ({
      total: jobs.length,
      running: jobs.filter((job) => ["Queued", "Planning", "Implementing", "PolicyChecking", "Publishing"].includes(String(job.phase))).length,
      failed: jobs.filter((job) => String(job.phase).startsWith("Failed") || String(job.outcome).startsWith("Failed")).length,
      completed: jobs.filter((job) => job.phase === "Completed").length
    }),
    [jobs]
  );

  useEffect(() => {
    if (!token) return;
    void refreshJobs(token);
  }, [token]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = copy.documentTitle;
  }, [copy.documentTitle, locale]);

  useEffect(() => {
    if (!selectedJobId || !token) {
      setDetail(emptyDetail);
      return;
    }

    void refreshDetail(selectedJobId, token);
  }, [selectedJobId, token]);

  async function refreshJobs(activeToken = token) {
    if (!activeToken.trim()) {
      setStatus({ kind: "enterToken" });
      return;
    }

    setIsLoadingJobs(true);
    setError("");
    try {
      const nextJobs = await fetchJobs(activeToken);
      setJobs(nextJobs);
      setSelectedJobId((current) => current || nextJobs[0]?.id || "");
      setStatus({ kind: "loadedJobs", count: nextJobs.length });
    } catch (caught) {
      setError(errorMessage(caught, copy));
      setStatus({ kind: "refreshFailed" });
    } finally {
      setIsLoadingJobs(false);
    }
  }

  async function refreshDetail(jobId: string, activeToken = token) {
    setIsLoadingDetail(true);
    setError("");
    try {
      const [job, events, logs, artifacts] = await Promise.all([
        fetchJob(jobId, activeToken),
        fetchJobEvents(jobId, activeToken),
        fetchJobLogs(jobId, activeToken),
        fetchJobArtifacts(jobId, activeToken)
      ]);
      setDetail({ job, events, logs, artifacts });
    } catch (caught) {
      setError(errorMessage(caught, copy));
      setDetail(emptyDetail);
    } finally {
      setIsLoadingDetail(false);
    }
  }

  function saveToken() {
    storeAdminToken(token);
    void refreshJobs(token);
  }

  async function runAction(action: "retry" | "cancel") {
    if (!selectedJobId) return;

    setActionState(action);
    setError("");
    try {
      if (action === "retry") {
        const retry = await retryJob(selectedJobId, token);
        setStatus({ kind: "retryQueued", attempt: retry.attempt });
      } else {
        const cancel = await cancelJob(selectedJobId, token);
        setStatus({ kind: "cancelRequested", phase: cancel.phase });
      }
      await refreshJobs(token);
      await refreshDetail(selectedJobId, token);
    } catch (caught) {
      setError(errorMessage(caught, copy));
    } finally {
      setActionState("");
    }
  }

  function changeLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    storeLocale(nextLocale);
  }

  return (
    <main className="min-h-screen bg-linen-white px-4 py-4 text-true-black md:px-6">
      <header className="mx-auto flex max-w-[var(--page-max-width)] flex-col gap-2">
        <nav className="flex flex-col gap-3 rounded-xl border border-hairline-gray bg-linen-white px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-forest-ink text-sm text-linen-white">✓</span>
            <div className="min-w-0">
              <p className="text-[12px] leading-4 text-charcoal">{copy.appEyebrow}</p>
              <h1 className="font-sans text-[24px] font-semibold leading-[1.15] text-forest-ink md:text-[26px]">
                {copy.appTitle}
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-1 rounded-lg bg-linen p-1">
            {(["ko", "en"] as Locale[]).map((entry) => (
              <Button
                key={entry}
                type="button"
                size="sm"
                variant={locale === entry ? "default" : "ghost"}
                className="h-8"
                onClick={() => changeLocale(entry)}
              >
                {localeNames[entry]}
              </Button>
            ))}
          </div>
        </nav>

        <form
          className="grid gap-3 rounded-xl border border-hairline-gray bg-linen px-4 py-3 md:grid-cols-[120px_minmax(240px,1fr)_auto_auto] md:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            saveToken();
          }}
        >
          <label className="text-[13px] font-medium text-charcoal" htmlFor="admin-token">
            {copy.tokenLabel}
          </label>
          <Input
            id="admin-token"
            value={token}
            type="password"
            autoComplete="off"
            placeholder={copy.tokenPlaceholder}
            onChange={(event) => setToken(event.target.value)}
          />
          <Button type="submit">
            {copy.apply}
          </Button>
          <Button type="button" variant="outline" onClick={() => void refreshJobs(token)}>
            {copy.refresh}
          </Button>
        </form>
        <div className="flex flex-col gap-3 rounded-xl border border-hairline-gray bg-linen-white px-4 py-2.5 md:flex-row md:items-center md:justify-between" aria-live="polite">
          <div className="flex flex-wrap gap-2">
            <MetricPill label={copy.totalJobs} value={jobStats.total} />
            <MetricPill label={copy.runningJobs} value={jobStats.running} />
            <MetricPill label={copy.failedJobs} value={jobStats.failed} />
            <MetricPill label={copy.completedJobs} value={jobStats.completed} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{jobs.length}</Badge>
            <span className="text-[13px] text-charcoal">{renderStatus(status, copy)}</span>
            {error ? <strong className="rounded-full bg-forest-ink px-3 py-1 text-xs font-normal text-linen-white">{error}</strong> : null}
          </div>
        </div>
      </header>

      <section className="mx-auto mt-3 grid max-w-[var(--page-max-width)] items-start gap-4 xl:grid-cols-[minmax(520px,0.95fr)_minmax(0,1.05fr)]">
        <JobList
          jobs={jobs}
          selectedJobId={selectedJobId}
          isLoading={isLoadingJobs}
          copy={copy}
          locale={locale}
          onSelectJob={setSelectedJobId}
        />
        <JobDetail
          job={selectedJob}
          events={detail.events}
          logs={detail.logs}
          artifacts={detail.artifacts}
          isLoading={isLoadingDetail}
          actionState={actionState}
          copy={copy}
          locale={locale}
          onCancel={() => void runAction("cancel")}
          onRetry={() => void runAction("retry")}
        />
      </section>
    </main>
  );
}

function errorMessage(error: unknown, copy: AdminCopy): string {
  if (error instanceof Error && error.message === "admin_access_key_required") return copy.tokenRequired;
  return error instanceof Error ? error.message : "Unknown error";
}

function renderStatus(status: StatusState, copy: AdminCopy): string {
  if (status.kind === "ready") return copy.ready;
  if (status.kind === "enterToken") return copy.enterToken;
  if (status.kind === "loadedJobs") return copy.loadedJobs(status.count);
  if (status.kind === "refreshFailed") return copy.refreshFailed;
  if (status.kind === "retryQueued") return copy.retryQueued(status.attempt);
  return copy.cancelRequested(status.phase);
}

function MetricPill({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-linen px-2.5 py-1 text-[12px] leading-4 text-charcoal">
      {label}
      <strong className="font-semibold text-forest-ink">{value}</strong>
    </span>
  );
}
