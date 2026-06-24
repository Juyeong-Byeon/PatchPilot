import { useEffect, useMemo, useRef, useState } from "react";
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ListChecks,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import adminLogo from "./assets/patchpilot-logo.svg";
import {
  answerJob,
  cancelJob,
  fetchJob,
  fetchJobArtifacts,
  fetchJobEvents,
  fetchJobLogs,
  fetchJobs,
  getAdminApiDisplayUrl,
  getAdminApiRequestMode,
  getAdminFrontendOrigin,
  getStoredAdminToken,
  getVersion,
  retryJob,
  storeAdminToken,
  type Artifact,
  type JobRecord,
  type LogLine,
  type RunEvent,
  type VersionInfo,
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
import { ConnectionBadge } from "./components/ConnectionBadge.js";
import { VersionBadge } from "./components/VersionBadge.js";
import { adminCopy, getInitialLocale, storeLocale, type AdminCopy, type Locale } from "./i18n.js";
import { createQueryClient } from "./lib/query-client.js";

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
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <AppInner />
    </QueryClientProvider>
  );
}

function AppInner() {
  const [route, setRoute] = useState<AdminRoute>(() => readRoute());
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale());
  const [theme, setTheme] = useState<ThemePreference>(() => getInitialTheme());
  const copy = adminCopy[locale];
  const [token, setToken] = useState(() => getStoredAdminToken());
  const [tokenDraft, setTokenDraft] = useState(token);
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const tokenInputRef = useRef<HTMLInputElement | null>(null);
  const selectedJobId = route.page === "detail" ? route.jobId : "";
  // No saved token, or the session expired: gate the whole app behind onboarding
  // instead of the sidebar+content grid.
  const showOnboarding = !token.trim() || sessionExpired;

  // Single re-auth boundary: stop polling, surface one state, focus the token form.
  function handleSessionExpiry() {
    setSessionExpired(true);
    setTokenDraft(token);
    setStatus({ kind: "sessionExpired" });
    setListError(copy.tokenInvalid);
    // Defer focus until after the re-render that re-enables the form.
    window.setTimeout(() => tokenInputRef.current?.focus(), 0);
  }

  const queryClient = useQueryClient();
  const queryEnabled = !!token.trim() && !sessionExpired;

  const jobsQuery = useQuery({
    queryKey: ["jobs", token],
    queryFn: () => fetchJobs(token),
    enabled: queryEnabled,
    refetchInterval: (query) => {
      if (route.page !== "list" || sessionExpired) return false;
      const running = (query.state.data ?? []).filter((job) => isRunningPhase(job.phase)).length;
      return running > 0 ? LIST_REFRESH_RUNNING_MS : LIST_REFRESH_IDLE_MS;
    },
  });
  const jobs = useMemo(() => jobsQuery.data ?? [], [jobsQuery.data]);

  const detailQuery = useQuery({
    queryKey: ["detail", selectedJobId, token],
    queryFn: async (): Promise<DetailState> => {
      const [job, events, logs, artifacts] = await Promise.all([
        fetchJob(selectedJobId, token),
        fetchJobEvents(selectedJobId, token),
        fetchJobLogs(selectedJobId, token),
        fetchJobArtifacts(selectedJobId, token),
      ]);
      return { job, events, logs, artifacts };
    },
    enabled: queryEnabled && !!selectedJobId,
    refetchInterval: (query) => (sessionExpired ? false : isRunningPhase(query.state.data?.job?.phase) ? 1000 : 3000),
  });
  const detail = detailQuery.data ?? emptyDetail;

  // The running build's version + git SHA, shown in the sidebar footer so operators can
  // verify which build is serving traffic. `/api/version` is public (no token, like
  // /api/health) and informational, so the query runs unconditionally, never refetches
  // (the build only changes on redeploy → a fresh page load), and is silent on failure:
  // getVersion throws VERSION_UNAVAILABLE and the badge simply renders nothing.
  const versionQuery = useQuery({
    queryKey: ["version"],
    queryFn: getVersion,
    staleTime: Infinity,
    refetchInterval: false,
    retry: false,
  });
  const version: VersionInfo | null = versionQuery.data ?? null;
  const frontendOrigin = useMemo(() => getAdminFrontendOrigin(), []);
  const apiDisplayUrl = useMemo(() => getAdminApiDisplayUrl(), []);
  const apiRequestMode = useMemo(() => getAdminApiRequestMode(), []);

  const selectedJob = useMemo(
    () => (route.page === "detail" ? (detail.job ?? jobs.find((job) => job.id === route.jobId) ?? null) : null),
    [detail.job, jobs, route],
  );
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
  // Jobs that need an operator to act — a parked question to answer or a PR to
  // review. Surfaced in the tab title so the work is noticeable from another tab.
  const needsAttention = jobStats.needsInput + jobStats.needsReview;

  // Single re-auth boundary: a 401 on either query freezes polling, surfaces one
  // re-auth state, and focuses the token form.
  useEffect(() => {
    if (isSessionExpiredError(jobsQuery.error) || isSessionExpiredError(detailQuery.error)) handleSessionExpiry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobsQuery.error, detailQuery.error]);

  useEffect(() => {
    if (jobsQuery.isSuccess) {
      setListError("");
      setStatus({ kind: "loadedJobs", count: jobsQuery.data.length });
    }
  }, [jobsQuery.data, jobsQuery.isSuccess]);

  useEffect(() => {
    if (jobsQuery.error && !isSessionExpiredError(jobsQuery.error)) {
      setListError(errorMessage(jobsQuery.error, copy));
      // Only a foreground/initial load failure changes the status line. A transient
      // background-poll error still surfaces via listError but must not flash
      // refreshFailed — parity with the old silent-poll path (isLoadingError is true
      // only when the query errored with no prior data, i.e. the initial load).
      if (jobsQuery.isLoadingError) setStatus({ kind: "refreshFailed" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobsQuery.error]);

  useEffect(() => {
    if (detailQuery.error && !isSessionExpiredError(detailQuery.error))
      setDetailError(errorMessage(detailQuery.error, copy));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailQuery.error]);

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
    // Prefix the tab title with the count of jobs needing an operator so the work
    // is noticeable from another tab/window — e.g. "(3) PatchPilot …".
    document.title = needsAttention > 0 ? `(${needsAttention}) ${copy.documentTitle}` : copy.documentTitle;
  }, [copy.documentTitle, locale, needsAttention]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Focus the access-key field whenever the onboarding gate appears (initial load
  // or session-expiry re-auth) so the operator can type immediately.
  useEffect(() => {
    if (showOnboarding) tokenInputRef.current?.focus();
  }, [showOnboarding]);

  useEffect(() => {
    if (!selectedJobId) return;

    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [selectedJobId]);

  function saveToken(nextToken = token) {
    const normalizedToken = nextToken.trim();
    setToken(normalizedToken);
    setTokenDraft(normalizedToken);
    storeAdminToken(normalizedToken);
    // Re-authentication clears the expiry boundary and resumes polling. Applying a
    // token also leaves the sidebar edit stage / dismisses the onboarding gate.
    setSessionExpired(false);
    setEditingToken(false);
    setListError("");
    setStatus(normalizedToken ? { kind: "ready" } : { kind: "enterToken" });
    void queryClient.invalidateQueries({ queryKey: ["jobs"] });
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
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      await queryClient.invalidateQueries({ queryKey: ["detail", selectedJobId] });
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
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      await queryClient.invalidateQueries({ queryKey: ["detail", selectedJobId] });
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

  function changeEditingToken(nextEditingToken: boolean) {
    setTokenDraft(token);
    setEditingToken(nextEditingToken);
  }

  function refreshCurrentDetail() {
    if (!selectedJobId) return;
    void queryClient.invalidateQueries({ queryKey: ["detail", selectedJobId] });
  }

  const pageTitle = route.page === "settings" ? copy.settings : route.page === "list" ? copy.jobs : copy.jobDetail;

  // Onboarding gate: with no saved token (or after a session-expiry 401) render a
  // dedicated, centered access-key screen instead of the sidebar+content grid.
  if (showOnboarding) {
    return (
      <div className="admin-shell flex min-h-screen flex-col items-center justify-center px-4 py-10 text-true-black">
        <Card className="w-full max-w-[420px]">
          <div className="grid gap-3 px-6 py-7">
            <div className="grid gap-1 text-left">
              <h1 className="text-[20px] font-semibold leading-6 text-forest-ink">{copy.onboardingHeading}</h1>
              <p className="text-[13px] leading-5 text-charcoal">{copy.onboardingSubtitle}</p>
            </div>

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
                const submittedToken = new FormData(event.currentTarget).get("admin-token");
                saveToken(typeof submittedToken === "string" ? submittedToken : token);
              }}
            >
              <label htmlFor="onboarding-token" className="grid gap-1.5 text-left">
                <span className="sr-only">{copy.tokenLabel}</span>
                <Input
                  id="onboarding-token"
                  name="admin-token"
                  ref={tokenInputRef}
                  value={tokenDraft}
                  type="password"
                  autoComplete="off"
                  placeholder={copy.tokenPlaceholder}
                  aria-invalid={sessionExpired || undefined}
                  onChange={(event) => setTokenDraft(event.target.value)}
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
        <ConnectionBadge
          frontendOrigin={frontendOrigin}
          apiDisplayUrl={apiDisplayUrl}
          requestMode={apiRequestMode}
          version={version}
          copy={copy}
          className="mt-3 w-full max-w-[420px]"
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "admin-shell grid min-h-screen text-true-black transition-[grid-template-columns] duration-200 lg:grid-cols-[236px_minmax(0,1fr)]",
        sidebarCollapsed && "lg:grid-cols-[64px_minmax(0,1fr)]",
      )}
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-lg focus:bg-cobalt-surface focus:px-3 focus:py-2 focus:text-paper"
      >
        {copy.skipToContent}
      </a>
      <aside
        className={cn(
          "admin-sidebar sticky top-0 z-30 border-b border-hairline-gray bg-linen-white/95 lg:h-screen lg:border-b-0 lg:border-r",
          sidebarCollapsed && "admin-sidebar-collapsed",
        )}
      >
        <div
          className={cn(
            "flex h-full flex-col gap-3 px-3 py-3 sm:px-4 lg:gap-5 lg:px-4 lg:py-4",
            sidebarCollapsed && "lg:items-center lg:px-3",
          )}
        >
          <div className={cn("flex min-w-0 items-center gap-3", sidebarCollapsed && "lg:flex-col")}>
            <img
              src={adminLogo}
              alt=""
              aria-hidden="true"
              className="status-glow-active size-9 shrink-0 rounded-xl border border-electric-blue/20 bg-mist-blue object-contain p-1"
            />
            <div className={cn("min-w-0", sidebarCollapsed && "lg:hidden")}>
              <p className="text-[12px] leading-4 text-charcoal">{copy.appEyebrow}</p>
              <strong className="block truncate text-[17px] font-semibold leading-5 text-forest-ink">
                {copy.appTitle}
              </strong>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("ml-auto hidden lg:inline-flex", sidebarCollapsed && "lg:ml-0")}
              aria-label={sidebarCollapsed ? copy.expandSidebar : copy.collapseSidebar}
              title={sidebarCollapsed ? copy.expandSidebar : copy.collapseSidebar}
              aria-expanded={!sidebarCollapsed}
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            >
              {sidebarCollapsed ? (
                <PanelLeftOpen data-icon aria-hidden="true" strokeWidth={2.2} />
              ) : (
                <PanelLeftClose data-icon aria-hidden="true" strokeWidth={2.2} />
              )}
            </Button>
          </div>

          <div
            className={cn(
              "flex min-w-0 items-center gap-2 lg:mt-0 lg:flex-1 lg:flex-col lg:items-stretch lg:gap-5",
              sidebarCollapsed && "lg:items-center",
            )}
          >
            <nav
              className={cn(
                "flex min-w-0 flex-1 gap-2 overflow-x-auto pb-0.5 lg:grid lg:w-auto lg:flex-none lg:gap-1 lg:overflow-visible lg:pb-0",
                sidebarCollapsed && "lg:w-10",
              )}
              aria-label={copy.appTitle}
            >
              <NavItem
                label={copy.jobs}
                Icon={ListChecks}
                active={route.page === "list" || route.page === "detail"}
                collapsed={sidebarCollapsed}
                onClick={openJobList}
              />
              <NavItem
                label={copy.settings}
                Icon={SettingsIcon}
                active={route.page === "settings"}
                collapsed={sidebarCollapsed}
                onClick={openSettings}
              />
            </nav>

            <div className={cn("shrink-0 lg:mt-auto lg:grid lg:gap-4", sidebarCollapsed && "lg:w-10")}>
              <ThemeToggle copy={copy} theme={theme} collapsed={sidebarCollapsed} onChangeTheme={changeTheme} />
              {!sidebarCollapsed ? (
                <footer className="hidden border-t border-hairline-gray pt-4 text-[12px] leading-5 text-charcoal lg:block">
                  <p className="m-0 font-medium text-forest-ink">{copy.appTitle}</p>
                  <p className="m-0 mt-1">{copy.footerScope}</p>
                  <VersionBadge version={version} copy={copy} />
                </footer>
              ) : null}
            </div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="admin-topbar border-b border-hairline-gray bg-linen-white/86">
          <section className="mx-auto max-w-[var(--page-max-width)] px-3 py-3 sm:px-4 sm:py-4 md:px-6 md:py-5">
            <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
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
                    <h1 className="mt-1 truncate text-[24px] font-semibold leading-[1.12] text-forest-ink md:text-[32px]">
                      {pageTitle}
                    </h1>
                  </div>
                </div>
                {route.page === "list" ? (
                  <div
                    className="-mx-3 mt-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
                    role="group"
                    aria-label={copy.filterJobsLabel}
                  >
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
              <ConnectionBadge
                frontendOrigin={frontendOrigin}
                apiDisplayUrl={apiDisplayUrl}
                requestMode={apiRequestMode}
                version={version}
                copy={copy}
                className="w-full max-w-full xl:w-[360px]"
              />
            </div>
          </section>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-[var(--page-max-width)] flex-1 px-4 py-5 md:px-6"
        >
          {route.page === "settings" ? (
            <SettingsPanel
              token={token}
              tokenDraft={tokenDraft}
              copy={copy}
              locale={locale}
              sessionExpired={sessionExpired}
              onSessionExpired={handleSessionExpiry}
              status={renderStatus(status, copy)}
              listError={!sessionExpired ? listError : ""}
              editingToken={editingToken}
              onEditingTokenChange={changeEditingToken}
              onTokenChange={setTokenDraft}
              onSaveToken={saveToken}
              onRefresh={() => void queryClient.invalidateQueries({ queryKey: ["jobs"] })}
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
                isLoading={jobsQuery.isPending}
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
              isLoading={detailQuery.isPending}
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
  collapsed,
  onChangeTheme,
}: {
  copy: AdminCopy;
  theme: ThemePreference;
  collapsed: boolean;
  onChangeTheme(next: ThemePreference): void;
}) {
  return (
    <div
      className={cn("flex items-center gap-1 rounded-lg bg-mist-blue p-1", collapsed && "lg:flex-col")}
      role="group"
      aria-label={copy.themeLabel}
    >
      {THEME_OPTIONS.map(({ value, Icon, labelKey }) => (
        <Button
          key={value}
          type="button"
          size="sm"
          variant={theme === value ? "default" : "ghost"}
          className={cn("h-8 flex-1 px-0", collapsed && "lg:w-8 lg:flex-none")}
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
  collapsed,
  onClick,
}: {
  label: string;
  Icon: typeof ListChecks;
  active: boolean;
  collapsed: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "interactive-card inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full border px-3 text-left text-[13px] font-medium transition-colors lg:w-auto lg:justify-start lg:rounded-lg",
        collapsed && "lg:h-10 lg:w-10 lg:justify-center lg:px-0",
        active
          ? "border-electric-blue/20 bg-mist-blue text-cobalt-surface shadow-sm shadow-electric-blue/10 hover:border-electric-blue/40 hover:bg-sage-wash"
          : "border-transparent bg-transparent text-charcoal hover:bg-mist-blue hover:text-forest-ink",
      )}
    >
      <Icon aria-hidden="true" size={16} strokeWidth={2.2} />
      <span className={cn(collapsed && "lg:sr-only")}>{label}</span>
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
        "interactive-card inline-flex shrink-0 items-center gap-2 rounded-full border px-2.5 py-1 text-[12px] leading-4 shadow-sm transition-colors",
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
