import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ListChecks } from "lucide-react";
import adminLogo from "./assets/admin-logo.png";
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

type AdminRoute =
  | { page: "list" }
  | { page: "detail"; jobId: string };

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
  const [route, setRoute] = useState<AdminRoute>(() => readRoute());
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale());
  const copy = adminCopy[locale];
  const [token, setToken] = useState(() => getStoredAdminToken());
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [detail, setDetail] = useState<DetailState>(emptyDetail);
  const [isLoadingJobs, setIsLoadingJobs] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [status, setStatus] = useState<StatusState>(() => (token ? { kind: "ready" } : { kind: "enterToken" }));
  const [error, setError] = useState<string>("");
  const [actionState, setActionState] = useState<string>("");
  const selectedJobId = route.page === "detail" ? route.jobId : "";

  const selectedJob = useMemo(
    () => route.page === "detail" ? detail.job ?? jobs.find((job) => job.id === route.jobId) ?? null : null,
    [detail.job, jobs, route]
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
    if (window.location.pathname === "/") {
      window.history.replaceState(null, "", "/jobs");
    }

    function syncRoute() {
      setRoute(readRoute());
    }

    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

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

  useEffect(() => {
    if (!selectedJobId || !token) return;

    const intervalId = window.setInterval(() => {
      void refreshDetail(selectedJobId, token, { silent: true });
    }, 3000);

    return () => window.clearInterval(intervalId);
  }, [selectedJobId, token]);

  useEffect(() => {
    if (!selectedJobId) return;

    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [selectedJobId]);

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
      setStatus({ kind: "loadedJobs", count: nextJobs.length });
    } catch (caught) {
      setError(errorMessage(caught, copy));
      setStatus({ kind: "refreshFailed" });
    } finally {
      setIsLoadingJobs(false);
    }
  }

  async function refreshDetail(jobId: string, activeToken = token, options: { silent?: boolean } = {}) {
    if (!options.silent) setIsLoadingDetail(true);
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
    } finally {
      if (!options.silent) setIsLoadingDetail(false);
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

  function openJob(jobId: string) {
    navigate({ page: "detail", jobId });
  }

  function openJobList() {
    navigate({ page: "list" });
  }

  function refreshCurrentDetail() {
    if (!selectedJobId) return;
    void refreshDetail(selectedJobId, token);
  }

  const pageTitle = route.page === "list" ? copy.jobs : copy.jobDetail;
  return (
    <div className="admin-shell grid min-h-screen text-true-black lg:grid-cols-[236px_minmax(0,1fr)]">
      <aside className="admin-sidebar border-b border-hairline-gray bg-linen-white/95 lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex h-full flex-col gap-5 px-4 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <img
              src={adminLogo}
              alt=""
              aria-hidden="true"
              className="status-glow-active size-9 shrink-0 rounded-xl border border-electric-blue/20 bg-mist-blue object-cover"
            />
            <div className="min-w-0">
              <p className="text-[12px] leading-4 text-charcoal">{copy.appEyebrow}</p>
              <strong className="block truncate text-[17px] font-semibold leading-5 text-forest-ink">{copy.appTitle}</strong>
            </div>
          </div>

          <nav className="grid gap-1" aria-label={copy.appTitle}>
            <button
              className="interactive-card inline-flex h-9 items-center gap-2 rounded-lg border border-electric-blue/20 bg-mist-blue px-3 text-left text-[13px] font-medium text-cobalt-surface shadow-sm shadow-electric-blue/10 transition-colors hover:border-electric-blue/40 hover:bg-sage-wash"
              type="button"
              onClick={openJobList}
            >
              <ListChecks aria-hidden="true" size={16} strokeWidth={2.2} />
              {copy.jobs}
            </button>
          </nav>

          <div className="mt-auto grid gap-4">
            <section className="surface-card-soft rounded-xl border border-hairline-gray bg-linen-white p-3">
              <div className="mb-2">
                <strong className="text-[13px] font-semibold text-forest-ink">{copy.tokenLabel}</strong>
              </div>
              <form
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveToken();
                }}
              >
                <label className="sr-only" htmlFor="admin-token">
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
                <div className="grid grid-cols-2 gap-2">
                  <Button type="submit">
                    {copy.apply}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => void refreshJobs(token)}>
                    {copy.refresh}
                  </Button>
                </div>
              </form>
              <div className="mt-2" aria-live="polite">
                <span className="text-[12px] leading-4 text-charcoal">{renderStatus(status, copy)}</span>
                {error ? <strong className="mt-2 block rounded-lg bg-danger px-2.5 py-1.5 text-xs font-normal leading-4 text-white">{error}</strong> : null}
              </div>
            </section>

            <div className="flex items-center gap-1 rounded-lg bg-mist-blue p-1">
              {(["ko", "en"] as Locale[]).map((entry) => (
                <Button
                  key={entry}
                  type="button"
                  size="sm"
                  variant={locale === entry ? "default" : "ghost"}
                  className="h-8 flex-1"
                  onClick={() => changeLocale(entry)}
                >
                  {localeNames[entry]}
                </Button>
              ))}
            </div>
            <footer className="border-t border-hairline-gray pt-4 text-[12px] leading-5 text-charcoal">
              <p className="m-0 font-medium text-forest-ink">{copy.appTitle}</p>
              <p className="m-0 mt-1">{copy.footerScope}</p>
            </footer>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="admin-topbar border-b border-hairline-gray bg-linen-white/86">
          <section className="mx-auto max-w-[var(--page-max-width)] px-4 py-5 md:px-6">
            <div className="min-w-0">
              <div className="flex min-w-0 items-start gap-3">
                {route.page === "detail" ? (
                  <Button type="button" variant="ghost" size="icon" aria-label={copy.backToJobs} title={copy.backToJobs} onClick={openJobList}>
                    <ChevronLeft data-icon aria-hidden="true" strokeWidth={2.3} />
                  </Button>
                ) : null}
                <div className="min-w-0">
                  <p className="text-[12px] font-medium leading-4 text-cobalt-surface">{copy.appEyebrow}</p>
                  <h1 className="mt-1 truncate text-[28px] font-semibold leading-[1.12] text-forest-ink md:text-[34px]">
                    {pageTitle}
                  </h1>
                </div>
              </div>
              {route.page === "list" ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  <MetricPill label={copy.totalJobs} value={jobStats.total} />
                  <MetricPill label={copy.runningJobs} value={jobStats.running} />
                  <MetricPill label={copy.failedJobs} value={jobStats.failed} />
                  <MetricPill label={copy.completedJobs} value={jobStats.completed} />
                </div>
              ) : null}
            </div>
          </section>
        </header>

        <main className="mx-auto w-full max-w-[var(--page-max-width)] flex-1 px-4 py-5 md:px-6">
          {route.page === "list" ? (
            <JobList
              jobs={jobs}
              selectedJobId={selectedJobId}
              isLoading={isLoadingJobs}
              copy={copy}
              locale={locale}
              onOpenJob={openJob}
            />
          ) : (
            <JobDetail
              job={selectedJob}
              events={detail.events}
              logs={detail.logs}
              artifacts={detail.artifacts}
              isLoading={isLoadingDetail}
              actionState={actionState}
              nowMs={nowMs}
              copy={copy}
              locale={locale}
              onBack={openJobList}
              onRefresh={refreshCurrentDetail}
              onCancel={() => void runAction("cancel")}
              onRetry={() => void runAction("retry")}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function readRoute(): AdminRoute {
  const match = window.location.pathname.match(/^\/jobs\/(.+)$/);
  if (!match) return { page: "list" };

  try {
    return { page: "detail", jobId: decodeURIComponent(match[1]) };
  } catch {
    return { page: "list" };
  }
}

function navigate(route: AdminRoute) {
  const path = route.page === "detail" ? `/jobs/${encodeURIComponent(route.jobId)}` : "/jobs";
  window.history.pushState(null, "", path);
  window.dispatchEvent(new Event("popstate"));
}

function errorMessage(error: unknown, copy: AdminCopy): string {
  if (error instanceof Error && error.message === "admin_access_key_required") return copy.tokenRequired;
  if (error instanceof Error && error.message === "admin_access_key_invalid") return copy.tokenInvalid;
  if (error instanceof Error && error.message === "admin_api_unavailable") return copy.apiUnavailable;
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
    <span className="inline-flex items-center gap-2 rounded-full border border-hairline-gray bg-linen-white px-2.5 py-1 text-[12px] leading-4 text-charcoal shadow-sm shadow-midnight-ink/5">
      {label}
      <strong className="font-semibold text-forest-ink">{value}</strong>
    </span>
  );
}
