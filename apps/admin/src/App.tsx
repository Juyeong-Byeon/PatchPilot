import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ListChecks, Monitor, Moon, Settings as SettingsIcon, Sun } from "lucide-react";
import adminLogo from "./assets/patchpilot-logo.svg";
import {
  answerJob,
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
  type RunEvent,
} from "./api.js";
import { JobDetail } from "./components/JobDetail.js";
import { JobList } from "./components/JobList.js";
import { Button } from "./components/ui/button.js";
import { Card } from "./components/ui/card.js";
import { Input } from "./components/ui/input.js";
import { cn } from "./lib/utils.js";
import {
  isCompletedJob,
  isFailedJob,
  isNeedsInputJob,
  isNeedsReviewJob,
  isRunningPhase,
  type StatusFilter,
} from "./lib/status.js";
import { applyTheme, getInitialTheme, storeTheme, type ThemePreference } from "./lib/theme.js";
import { MetricsPanel } from "./components/MetricsPanel.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { adminCopy, getInitialLocale, storeLocale, type AdminCopy, type Locale } from "./i18n.js";

const LIST_REFRESH_RUNNING_MS = 2000;
const LIST_REFRESH_IDLE_MS = 5000;

// Light / dark / system toggle. Labels come from i18n; icons keep the control
// compact in the sidebar. labelKey is a string-valued AdminCopy key.
const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  Icon: typeof Sun;
  labelKey: "themeLight" | "themeDark" | "themeSystem";
}> = [
  { value: "light", Icon: Sun, labelKey: "themeLight" },
  { value: "dark", Icon: Moon, labelKey: "themeDark" },
  { value: "system", Icon: Monitor, labelKey: "themeSystem" },
];

interface DetailState {
  job: JobRecord | null;
  events: RunEvent[];
  logs: LogLine[];
  artifacts: Artifact[];
}

type AdminRoute = { page: "list" } | { page: "detail"; jobId: string } | { page: "settings" };

type StatusState =
  | { kind: "ready" }
  | { kind: "enterToken" }
  | { kind: "sessionExpired" }
  | { kind: "loadedJobs"; count: number }
  | { kind: "refreshFailed" }
  | { kind: "retryQueued"; attempt: number }
  | { kind: "answerSubmitted"; attempt: number }
  | { kind: "cancelRequested"; phase: string };

// A 401 / invalid-key response means the session is no longer authenticated. We
// centralize this so every request path (foreground, silent poll, action) reacts
// the same way: stop polling, surface one re-auth state, focus the token form.
function isSessionExpiredError(error: unknown): boolean {
  return error instanceof Error && error.message === "admin_access_key_invalid";
}

const emptyDetail: DetailState = {
  job: null,
  events: [],
  logs: [],
  artifacts: [],
};

export default function App() {
  const [route, setRoute] = useState<AdminRoute>(() => readRoute());
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale());
  const [theme, setTheme] = useState<ThemePreference>(() => getInitialTheme());
  const copy = adminCopy[locale];
  const [token, setToken] = useState(() => getStoredAdminToken());
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [detail, setDetail] = useState<DetailState>(emptyDetail);
  const [isLoadingJobs, setIsLoadingJobs] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [status, setStatus] = useState<StatusState>(() => (token ? { kind: "ready" } : { kind: "enterToken" }));
  const [listError, setListError] = useState<string>("");
  const [detailError, setDetailError] = useState<string>("");
  const [actionState, setActionState] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // Once a 401 lands, all polling is frozen until the operator re-authenticates.
  const [sessionExpired, setSessionExpired] = useState(false);
  // The sidebar shows a compact "authenticated" block by default; the token input
  // only appears once the operator opts into editing it.
  const [editingToken, setEditingToken] = useState(false);
  const tokenInputRef = useRef<HTMLInputElement | null>(null);
  const selectedJobId = route.page === "detail" ? route.jobId : "";
  // No saved token, or the session expired: gate the whole app behind onboarding
  // instead of the sidebar+content grid.
  const showOnboarding = !token.trim() || sessionExpired;

  // Single re-auth boundary: stop polling, surface one state, focus the token form.
  function handleSessionExpiry() {
    setSessionExpired(true);
    setStatus({ kind: "sessionExpired" });
    setListError(copy.tokenInvalid);
    setIsLoadingJobs(false);
    setIsLoadingDetail(false);
    // Defer focus until after the re-render that re-enables the form.
    window.setTimeout(() => tokenInputRef.current?.focus(), 0);
  }

  const selectedJob = useMemo(
    () => (route.page === "detail" ? (detail.job ?? jobs.find((job) => job.id === route.jobId) ?? null) : null),
    [detail.job, jobs, route],
  );
  const detailRefreshMs = isRunningPhase(selectedJob?.phase) ? 1000 : 3000;
  const jobStats = useMemo(
    () => ({
      total: jobs.length,
      running: jobs.filter((job) => isRunningPhase(job.phase)).length,
      needsInput: jobs.filter((job) => isNeedsInputJob(job.phase, job.outcome)).length,
      needsReview: jobs.filter((job) => isNeedsReviewJob(job.phase, job.outcome)).length,
      failed: jobs.filter((job) => isFailedJob(job.phase, job.outcome)).length,
      // "완료" excludes jobs still parked on PR review so the chip mirrors the filter.
      completed: jobs.filter(
        (job) => isCompletedJob(job.phase, job.outcome) && !isNeedsReviewJob(job.phase, job.outcome),
      ).length,
    }),
    [jobs],
  );
  // Poll the list faster while any job is in flight so status + rows feel live.
  const listRefreshMs = jobStats.running > 0 ? LIST_REFRESH_RUNNING_MS : LIST_REFRESH_IDLE_MS;

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
    applyTheme(theme);
  }, [theme]);

  // Focus the access-key field whenever the onboarding gate appears (initial load
  // or session-expiry re-auth) so the operator can type immediately.
  useEffect(() => {
    if (showOnboarding) tokenInputRef.current?.focus();
  }, [showOnboarding]);

  useEffect(() => {
    if (!selectedJobId || !token) {
      setDetail(emptyDetail);
      return;
    }

    void refreshDetail(selectedJobId, token);
  }, [selectedJobId, token]);

  useEffect(() => {
    if (!selectedJobId || !token || sessionExpired) return;

    const intervalId = window.setInterval(() => {
      void refreshDetail(selectedJobId, token, { silent: true });
    }, detailRefreshMs);

    return () => window.clearInterval(intervalId);
  }, [detailRefreshMs, selectedJobId, token, sessionExpired]);

  useEffect(() => {
    if (!selectedJobId) return;

    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [selectedJobId]);

  useEffect(() => {
    if (route.page !== "list" || !token || sessionExpired) return;

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refreshJobs(token, { silent: true });
    }, listRefreshMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshJobs(token, { silent: true });
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [route.page, token, listRefreshMs, sessionExpired]);

  async function refreshJobs(activeToken = token, options: { silent?: boolean } = {}) {
    if (!activeToken.trim()) {
      setStatus({ kind: "enterToken" });
      return;
    }

    if (!options.silent) setIsLoadingJobs(true);
    setListError("");
    try {
      const nextJobs = await fetchJobs(activeToken);
      setJobs(nextJobs);
      if (!options.silent) setStatus({ kind: "loadedJobs", count: nextJobs.length });
    } catch (caught) {
      // A 401 freezes polling and routes to the single re-auth boundary — even on
      // the silent path, so an expired session never silently stalls the screen.
      if (isSessionExpiredError(caught)) {
        handleSessionExpiry();
        return;
      }
      setListError(errorMessage(caught, copy));
      if (!options.silent) setStatus({ kind: "refreshFailed" });
    } finally {
      if (!options.silent) setIsLoadingJobs(false);
    }
  }

  async function refreshDetail(jobId: string, activeToken = token, options: { silent?: boolean } = {}) {
    if (!options.silent) setIsLoadingDetail(true);
    setDetailError("");
    try {
      const [job, events, logs, artifacts] = await Promise.all([
        fetchJob(jobId, activeToken),
        fetchJobEvents(jobId, activeToken),
        fetchJobLogs(jobId, activeToken),
        fetchJobArtifacts(jobId, activeToken),
      ]);
      setDetail({ job, events, logs, artifacts });
    } catch (caught) {
      if (isSessionExpiredError(caught)) {
        handleSessionExpiry();
        return;
      }
      setDetailError(errorMessage(caught, copy));
    } finally {
      if (!options.silent) setIsLoadingDetail(false);
    }
  }

  function saveToken() {
    storeAdminToken(token);
    // Re-authentication clears the expiry boundary and resumes polling. Applying a
    // token also leaves the sidebar edit stage / dismisses the onboarding gate.
    setSessionExpired(false);
    setEditingToken(false);
    setListError("");
    setStatus(token.trim() ? { kind: "ready" } : { kind: "enterToken" });
    void refreshJobs(token);
  }

  async function runAction(action: "retry" | "cancel") {
    if (!selectedJobId) return;

    setActionState(action);
    setDetailError("");
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
      if (isSessionExpiredError(caught)) {
        handleSessionExpiry();
        return;
      }
      setDetailError(errorMessage(caught, copy));
    } finally {
      setActionState("");
    }
  }

  // Submit the operator's answer to a parked NeedsInput job, then refresh. Reuses the
  // shared session-expiry / error-surfacing boundary exactly like runAction.
  async function answerCurrentJob(answer: string) {
    if (!selectedJobId || !answer.trim()) return;

    setActionState("answer");
    setDetailError("");
    try {
      const resumed = await answerJob(selectedJobId, answer.trim(), token);
      setStatus({ kind: "answerSubmitted", attempt: resumed.attempt });
      await refreshJobs(token);
      await refreshDetail(selectedJobId, token);
    } catch (caught) {
      if (isSessionExpiredError(caught)) {
        handleSessionExpiry();
        return;
      }
      setDetailError(errorMessage(caught, copy));
    } finally {
      setActionState("");
    }
  }

  function changeLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    storeLocale(nextLocale);
  }

  function changeTheme(nextTheme: ThemePreference) {
    setTheme(nextTheme);
    storeTheme(nextTheme);
  }

  function openJob(jobId: string) {
    navigate({ page: "detail", jobId });
  }

  function openJobList() {
    navigate({ page: "list" });
  }

  function openSettings() {
    navigate({ page: "settings" });
  }

  function refreshCurrentDetail() {
    if (!selectedJobId) return;
    void refreshDetail(selectedJobId, token);
  }

  const pageTitle = route.page === "settings" ? copy.settings : route.page === "list" ? copy.jobs : copy.jobDetail;

  // Onboarding gate: with no saved token (or after a session-expiry 401) render a
  // dedicated, centered access-key screen instead of the sidebar+content grid.
  if (showOnboarding) {
    return (
      <div className="admin-shell flex min-h-screen flex-col items-center justify-center px-4 py-10 text-true-black">
        <Card className="w-full max-w-[420px]">
          <div className="grid gap-3 px-6 py-7">
            {sessionExpired ? (
              <div role="alert" className="rounded-lg border border-danger bg-danger-wash px-3 py-2 text-danger">
                <strong className="block text-[12px] font-semibold leading-4">{copy.sessionExpired}</strong>
                <span className="mt-1 block text-[11px] font-normal leading-4">{copy.sessionExpiredHint}</span>
              </div>
            ) : null}

            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                saveToken();
              }}
            >
              <label className="grid gap-1.5 text-left">
                <span className="sr-only">{copy.tokenLabel}</span>
                <Input
                  id="onboarding-token"
                  ref={tokenInputRef}
                  value={token}
                  type="password"
                  autoComplete="off"
                  placeholder={copy.tokenPlaceholder}
                  aria-invalid={sessionExpired || undefined}
                  onChange={(event) => setToken(event.target.value)}
                />
              </label>
              <Button type="submit" className="w-full">
                {copy.onboardingSubmit}
              </Button>
            </form>

            {listError && !sessionExpired ? (
              <strong
                role="alert"
                className="block rounded-lg bg-danger px-3 py-2 text-xs font-normal leading-4 text-white"
              >
                {listError}
              </strong>
            ) : null}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="admin-shell grid min-h-screen text-true-black lg:grid-cols-[236px_minmax(0,1fr)]">
      <aside className="admin-sidebar border-b border-hairline-gray bg-linen-white/95 lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex h-full flex-col gap-5 px-4 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <img
              src={adminLogo}
              alt=""
              aria-hidden="true"
              className="status-glow-active size-9 shrink-0 rounded-xl border border-electric-blue/20 bg-mist-blue object-contain p-1"
            />
            <div className="min-w-0">
              <p className="text-[12px] leading-4 text-charcoal">{copy.appEyebrow}</p>
              <strong className="block truncate text-[17px] font-semibold leading-5 text-forest-ink">
                {copy.appTitle}
              </strong>
            </div>
          </div>

          <nav className="grid gap-1" aria-label={copy.appTitle}>
            <NavItem
              label={copy.jobs}
              Icon={ListChecks}
              active={route.page === "list" || route.page === "detail"}
              onClick={openJobList}
            />
            <NavItem
              label={copy.settings}
              Icon={SettingsIcon}
              active={route.page === "settings"}
              onClick={openSettings}
            />
          </nav>

          <div className="mt-auto grid gap-4">
            <ThemeToggle copy={copy} theme={theme} onChangeTheme={changeTheme} />
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={copy.backToJobs}
                    title={copy.backToJobs}
                    onClick={openJobList}
                  >
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
                <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label={copy.filterJobsLabel}>
                  <MetricPill
                    label={copy.totalJobs}
                    value={jobStats.total}
                    active={statusFilter === "all"}
                    onClick={() => setStatusFilter("all")}
                  />
                  <MetricPill
                    label={copy.runningJobs}
                    value={jobStats.running}
                    active={statusFilter === "running"}
                    onClick={() => setStatusFilter("running")}
                  />
                  <MetricPill
                    label={copy.needsInputJobs}
                    value={jobStats.needsInput}
                    active={statusFilter === "needsInput"}
                    onClick={() => setStatusFilter("needsInput")}
                  />
                  <MetricPill
                    label={copy.needsReviewJobs}
                    value={jobStats.needsReview}
                    active={statusFilter === "needsReview"}
                    onClick={() => setStatusFilter("needsReview")}
                  />
                  <MetricPill
                    label={copy.failedJobs}
                    value={jobStats.failed}
                    active={statusFilter === "failed"}
                    onClick={() => setStatusFilter("failed")}
                  />
                  <MetricPill
                    label={copy.completedJobs}
                    value={jobStats.completed}
                    active={statusFilter === "completed"}
                    onClick={() => setStatusFilter("completed")}
                  />
                </div>
              ) : null}
            </div>
          </section>
        </header>

        <main className="mx-auto w-full max-w-[var(--page-max-width)] flex-1 px-4 py-5 md:px-6">
          {route.page === "settings" ? (
            <SettingsPanel
              token={token}
              copy={copy}
              locale={locale}
              sessionExpired={sessionExpired}
              onSessionExpired={handleSessionExpiry}
              status={renderStatus(status, copy)}
              listError={!sessionExpired ? listError : ""}
              editingToken={editingToken}
              onEditingTokenChange={setEditingToken}
              onTokenChange={setToken}
              onSaveToken={saveToken}
              onRefresh={() => void refreshJobs(token)}
              onChangeLocale={changeLocale}
            />
          ) : route.page === "list" ? (
            <div className="grid gap-4">
              <MetricsPanel
                token={token}
                copy={copy}
                sessionExpired={sessionExpired}
                onSessionExpired={handleSessionExpiry}
              />
              <JobList
                jobs={jobs}
                selectedJobId={selectedJobId}
                isLoading={isLoadingJobs}
                copy={copy}
                locale={locale}
                statusFilter={statusFilter}
                onOpenJob={openJob}
              />
            </div>
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
              error={detailError}
              onBack={openJobList}
              onRefresh={refreshCurrentDetail}
              onCancel={() => void runAction("cancel")}
              onRetry={() => void runAction("retry")}
              onAnswer={(answer) => void answerCurrentJob(answer)}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function readRoute(): AdminRoute {
  if (window.location.pathname === "/settings") return { page: "settings" };
  const match = window.location.pathname.match(/^\/jobs\/(.+)$/);
  const jobIdRaw = match?.[1];
  if (jobIdRaw === undefined) return { page: "list" };

  try {
    return { page: "detail", jobId: decodeURIComponent(jobIdRaw) };
  } catch {
    return { page: "list" };
  }
}

function navigate(route: AdminRoute) {
  const path =
    route.page === "detail"
      ? `/jobs/${encodeURIComponent(route.jobId)}`
      : route.page === "settings"
        ? "/settings"
        : "/jobs";
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
  if (status.kind === "sessionExpired") return copy.sessionExpired;
  if (status.kind === "loadedJobs") return copy.loadedJobs(status.count);
  if (status.kind === "refreshFailed") return copy.refreshFailed;
  if (status.kind === "retryQueued") return copy.retryQueued(status.attempt);
  if (status.kind === "answerSubmitted") return copy.needsInputSubmitted;
  return copy.cancelRequested(status.phase);
}

// Theme-only segmented control in the sidebar. Locale + account/auth controls moved
// to the Settings page (환경설정); theme stays here so appearance is always one click
// away regardless of the active route.
function ThemeToggle({
  copy,
  theme,
  onChangeTheme,
}: {
  copy: AdminCopy;
  theme: ThemePreference;
  onChangeTheme(next: ThemePreference): void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg bg-mist-blue p-1" role="group" aria-label={copy.themeLabel}>
      {THEME_OPTIONS.map(({ value, Icon, labelKey }) => (
        <Button
          key={value}
          type="button"
          size="sm"
          variant={theme === value ? "default" : "ghost"}
          className="h-8 flex-1 px-0"
          aria-pressed={theme === value}
          aria-label={copy[labelKey]}
          title={copy[labelKey]}
          onClick={() => onChangeTheme(value)}
        >
          <Icon data-icon aria-hidden="true" strokeWidth={2.2} />
        </Button>
      ))}
    </div>
  );
}

function NavItem({
  label,
  Icon,
  active,
  onClick,
}: {
  label: string;
  Icon: typeof ListChecks;
  active: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "interactive-card inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-left text-[13px] font-medium transition-colors",
        active
          ? "border-electric-blue/20 bg-mist-blue text-cobalt-surface shadow-sm shadow-electric-blue/10 hover:border-electric-blue/40 hover:bg-sage-wash"
          : "border-transparent bg-transparent text-charcoal hover:bg-mist-blue hover:text-forest-ink",
      )}
    >
      <Icon aria-hidden="true" size={16} strokeWidth={2.2} />
      {label}
    </button>
  );
}

function MetricPill({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: number;
  active: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "interactive-card inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[12px] leading-4 shadow-sm transition-colors",
        active
          ? "border-cobalt-surface bg-mist-blue text-cobalt-surface shadow-electric-blue/10"
          : "border-hairline-gray bg-linen-white text-charcoal shadow-midnight-ink/5 hover:border-electric-blue/40 hover:bg-mist-blue",
      )}
    >
      {label}
      <strong className={cn("font-semibold", active ? "text-cobalt-surface" : "text-forest-ink")}>{value}</strong>
    </button>
  );
}
