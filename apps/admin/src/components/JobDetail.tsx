import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitPullRequest,
  RotateCcw,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react";
import type { Artifact, JobRecord, LogLine, RunEvent } from "../api.js";
import { executorModeLabel, translateFailureCategory, translateState, type AdminCopy, type Locale } from "../i18n.js";
import { deriveStageStates, isNeedsReviewJob, resolvePrimaryStatus, statusBadgeVariant } from "../lib/status.js";
import {
  extractJobEvidence,
  normalizeExecutorMode,
  parseDefinitionOfDone,
  prFileDeepLink,
  prFilesUrl,
  readExecutorMode,
  type JobEvidence,
} from "../lib/evidence.js";
import { usePrFileAnchors } from "../lib/use-pr-file-anchors.js";
import { LogViewer } from "./LogViewer.js";
import { RunStepGraph } from "./RunStepGraph.js";
import { RunTimeline, type SpanSelection } from "./RunTimeline.js";
import { StageNotesPanel, isStageNoteArtifact } from "./StageNotesPanel.js";
import { StagePipeline } from "./StagePipeline.js";
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
  error?: string;
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
  error,
  onRefresh,
  onRetry,
  onCancel,
}: JobDetailProps) {
  const [selectedSpan, setSelectedSpan] = useState<SpanSelection | null>(null);
  const lastAutoFocusedKey = useRef<string>("");
  const currentAttempt = useMemo(() => resolveCurrentAttempt(job, events), [events, job]);
  const currentRunId = useMemo(() => resolveCurrentRunId(events, currentAttempt), [currentAttempt, events]);
  const currentEvents = useMemo(
    () => filterEventsForCurrentRun(events, currentAttempt, currentRunId),
    [currentAttempt, currentRunId, events],
  );
  const currentLogs = useMemo(() => filterRunScopedRecords(logs, currentRunId), [currentRunId, logs]);
  const currentArtifacts = useMemo(() => filterRunScopedRecords(artifacts, currentRunId), [artifacts, currentRunId]);
  const stageNotes = useMemo(() => currentArtifacts.filter(isStageNoteArtifact), [currentArtifacts]);
  const stageStates = useMemo(
    () => deriveStageStates(currentEvents, job?.phase, job?.outcome),
    [currentEvents, job?.outcome, job?.phase],
  );
  const runningPhase = useMemo(() => resolveRunningPhase(job), [job]);
  const selectedContext = useMemo(
    () => buildStepContext(selectedSpan, currentEvents, locale),
    [currentEvents, locale, selectedSpan],
  );
  const diagnosticLogs = useMemo(
    () => filterLogsForContext(currentLogs, selectedContext),
    [currentLogs, selectedContext],
  );
  const diagnosticArtifacts = useMemo(
    () =>
      filterArtifactsForContext(
        currentArtifacts.filter((artifact) => !isStageNoteArtifact(artifact)),
        selectedContext,
      ),
    [currentArtifacts, selectedContext],
  );

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
  // Mirror the backend retry preflight (repositories.ts): only Failed jobs whose
  // outcome is FailedInternal are retryable. Policy-blocked (FailedActionable)
  // jobs need a config/ticket change first, so the button stays disabled instead
  // of enabling an action that would 409.
  const retryDisabled = Boolean(actionState) || !(job.phase === "Failed" && String(job.outcome) === "FailedInternal");
  const cancelDisabled = Boolean(actionState) || terminal;
  const isCancelled = String(job.outcome) === "Cancelled" || String(job.phase) === "Cancelled";
  const needsReview = isNeedsReviewJob(job.phase, job.outcome);
  const primaryStatus = resolvePrimaryStatus(job);
  const executorMode = readExecutorMode(job);
  const ticketTitle = stringOrNull(job.title);
  const ticketDescription = stringOrNull(job.description);
  const dodText = stringOrNull(job.definition_of_done ?? job.definitionOfDone);
  const dodItems = parseDefinitionOfDone(dodText);
  const evidence = extractJobEvidence(currentArtifacts);
  const expectedTargetBranch = stringOrNull(job.target_branch ?? job.targetBranch);

  return (
    <section className="grid gap-4">
      <Card className="bg-linen-white">
        <CardContent className="grid gap-4">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1">
                <p className="truncate font-mono text-[12px] leading-4 text-graphite" title={job.id}>
                  {job.id}
                </p>
                <CopyButton value={job.id} copy={copy} />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {/* Single operator-facing primary status. The backend (phase, outcome)
                    pair is collapsed into one canonical state so Completed+NeedsReview
                    no longer reads as a contradiction; it shows as "PR 리뷰 대기". */}
                <Badge variant={statusBadgeVariant(primaryStatus)} aria-label={copy.primaryStatus}>
                  {translateState(primaryStatus, locale)}
                </Badge>
                {executorMode ? (
                  <Badge variant="outline" aria-label={copy.executorMode}>
                    {executorModeLabel(normalizeExecutorMode(executorMode), executorMode, copy)}
                  </Badge>
                ) : null}
              </div>
              <h2 className="mt-3 font-sans text-[22px] font-semibold leading-[1.25] text-forest-ink">
                {stringValue(job.repository, copy)}
              </h2>
              <p className="mt-1 text-[13px] leading-5 text-charcoal">
                {stringValue(job.target_branch ?? job.targetBranch, copy)} ·{" "}
                {stringValue(job.work_branch ?? job.workBranch, copy)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {onRefresh ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={copy.refresh}
                  title={copy.refresh}
                  disabled={isLoading}
                  onClick={onRefresh}
                >
                  <RotateCcw
                    data-icon
                    aria-hidden="true"
                    className={isLoading ? "animate-spin" : ""}
                    strokeWidth={2.2}
                  />
                </Button>
              ) : null}
              {job.pr_url ? <CopyButton value={job.pr_url} copy={copy} label={copy.openPr} /> : null}
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

          {error ? (
            <p role="alert" className="rounded-lg bg-danger px-3 py-2 text-[13px] leading-5 text-white">
              {error}
            </p>
          ) : null}

          {isCancelled && job.failure_reason ? (
            <section className="rounded-xl border border-hairline-gray bg-linen px-4 py-3">
              <p className="text-[12px] leading-4 text-charcoal">{copy.cancelInfo}</p>
              <p className="mt-2 break-words text-[13px] leading-5 text-true-black">{job.failure_reason}</p>
            </section>
          ) : !isCancelled && (job.failure_reason || job.next_action) ? (
            <section className="status-glow-failed rounded-xl border border-danger bg-danger-wash px-4 py-3">
              <p className="text-[12px] leading-4 text-charcoal">{copy.failureSummary}</p>
              {job.failure_reason ? (
                <p className="mt-2 break-words text-[13px] leading-5 text-danger">{job.failure_reason}</p>
              ) : null}
              {job.next_action ? (
                <p className="mt-2 break-words text-[13px] leading-5 text-true-black">
                  <span className="text-charcoal">{copy.nextAction}: </span>
                  {job.next_action}
                </p>
              ) : null}
            </section>
          ) : null}

          {/* NeedsReview is the dominant successful-terminal state: the operator's
              one job is to review/merge the PR. Surface that next action as a
              prominent, labeled CTA instead of relying on the bare PR icon button
              in the action cluster (which has no text and is easy to miss). */}
          {needsReview ? (
            <section className="flex flex-col gap-3 rounded-xl border border-amber-border bg-amber-wash px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="m-0 flex items-center gap-1.5 text-[13px] font-semibold leading-5 text-amber-ink">
                  <GitPullRequest aria-hidden="true" size={15} strokeWidth={2.4} className="shrink-0" />
                  {copy.reviewSummary}
                </p>
                <p className="m-0 mt-1 text-[12px] leading-4 text-charcoal">{copy.reviewHint}</p>
              </div>
              {job.pr_url ? (
                <a
                  className="cta-solid inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-amber-ink bg-amber-ink px-3 py-2 text-[13px] font-medium shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md"
                  href={job.pr_url}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLink aria-hidden="true" size={15} strokeWidth={2.4} />
                  {copy.reviewOpenPr}
                </a>
              ) : null}
            </section>
          ) : null}

          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Fact label={copy.priority} value={stringValue(job.priority, copy)} />
            <Fact label={copy.attempt} value={stringValue(job.attempt, copy)} />
            <Fact label={copy.updated} value={formatDate(job.updated_at, locale, copy)} />
            <Fact label={copy.failure} value={translateFailureCategory(job.failure_category, locale)} tone="danger" />
          </dl>
        </CardContent>
      </Card>

      <TicketPanel
        title={ticketTitle}
        description={ticketDescription}
        dodText={dodText}
        dodItems={dodItems}
        copy={copy}
      />

      <EvidenceCard
        evidence={evidence}
        artifacts={currentArtifacts}
        totalCount={currentArtifacts.length}
        expectedTargetBranch={expectedTargetBranch}
        prUrl={stringOrNull(job.pr_url)}
        copy={copy}
        locale={locale}
      />

      <RunStepGraph
        events={currentEvents}
        currentPhase={job.phase}
        copy={copy}
        locale={locale}
        selectedStep={selectedSpan}
        stageStates={stageStates}
        onSelectStep={setSelectedSpan}
      />
      {stageStates ? <StagePipeline stages={stageStates} nowMs={nowMs} copy={copy} /> : null}
      {/* Stage notes belong to the Implementing phase — show them only when that step is selected. */}
      {selectedSpan?.phase === "Implementing" && stageNotes.length > 0 ? (
        <StageNotesPanel notes={stageNotes} copy={copy} />
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{copy.runDiagnostics}</CardTitle>
          {selectedContext ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={copy.clear}
              title={copy.clear}
              onClick={() => setSelectedSpan(null)}
            >
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
            jobId={job.id}
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

function TicketPanel({
  title,
  description,
  dodText,
  dodItems,
  copy,
}: {
  title: string | null;
  description: string | null;
  dodText: string | null;
  dodItems: string[];
  copy: AdminCopy;
}) {
  const hasTicket = Boolean(title || description || dodText);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{copy.ticketPanel}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!hasTicket ? (
          <p className="text-[13px] leading-5 text-charcoal">{copy.noTicketContext}</p>
        ) : (
          <>
            {title ? <h3 className="m-0 text-[18px] font-semibold leading-6 text-forest-ink">{title}</h3> : null}
            {description ? (
              <div>
                <p className="mb-1 text-[12px] leading-4 text-charcoal">{copy.ticketDescription}</p>
                <p className="m-0 whitespace-pre-wrap break-words text-[13px] leading-5 text-true-black">
                  {description}
                </p>
              </div>
            ) : null}
            <div>
              <p className="mb-2 text-[12px] leading-4 text-charcoal">{copy.definitionOfDone}</p>
              {dodItems.length > 0 ? (
                <ul className="m-0 grid list-none gap-2 p-0" aria-label={copy.definitionOfDone}>
                  {dodItems.map((item, index) => (
                    <li
                      className="flex items-start gap-2 rounded-lg border border-hairline-gray bg-linen-white px-3 py-2 text-[13px] leading-5 text-true-black"
                      key={`${index}-${item}`}
                    >
                      <span
                        aria-hidden="true"
                        className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-hairline-gray text-graphite"
                      >
                        <Check size={11} strokeWidth={2.6} />
                      </span>
                      <span className="break-words">{item}</span>
                    </li>
                  ))}
                </ul>
              ) : dodText ? (
                <p className="m-0 whitespace-pre-wrap break-words text-[13px] leading-5 text-true-black">{dodText}</p>
              ) : (
                <p className="m-0 text-[13px] leading-5 text-charcoal">{copy.noDefinitionOfDone}</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// Cap the inline changed-files list; long diffs fall back to a "+N more" note that
// points at the PR's Files tab so the card never becomes a wall of paths.
const MAX_CHANGED_FILES = 20;

function EvidenceCard({
  evidence,
  artifacts,
  totalCount,
  expectedTargetBranch,
  prUrl,
  copy,
  locale,
}: {
  evidence: JobEvidence;
  artifacts: Artifact[];
  totalCount?: number;
  expectedTargetBranch: string | null;
  prUrl: string | null;
  copy: AdminCopy;
  locale: Locale;
}) {
  const [rawOpen, setRawOpen] = useState(false);

  const filesUrl = useMemo(() => prFilesUrl(prUrl), [prUrl]);
  const shownFiles = useMemo(() => evidence.changedFiles.slice(0, MAX_CHANGED_FILES), [evidence.changedFiles]);
  // Compute GitHub per-file diff anchors only when we actually have a PR to link to.
  const fileAnchors = usePrFileAnchors(shownFiles, Boolean(filesUrl));
  const hiddenFileCount = Math.max(0, evidence.changedFiles.length - shownFiles.length);

  // The two trust artifacts the worker records: gate verdict + executor evidence.
  const evidenceArtifacts = useMemo(
    () =>
      artifacts.filter((artifact) => {
        const kind = String(artifact.kind ?? "").toLowerCase();
        return kind.includes("policy") || kind.includes("agent-result") || kind === "result";
      }),
    [artifacts],
  );

  const protectedBadge: EvidenceBadgeSpec =
    evidence.deniedFiles.length === 0
      ? { tone: "ok", icon: "shield", label: copy.evidenceProtectedClean }
      : { tone: "danger", icon: "alert", label: copy.evidenceProtectedViolation(evidence.deniedFiles.length) };

  const policyBadge: EvidenceBadgeSpec =
    evidence.policyStatus === "passed"
      ? { tone: "ok", icon: "shield", label: copy.evidencePolicyPassed }
      : evidence.policyStatus === "failed"
        ? { tone: "danger", icon: "alert", label: copy.evidencePolicyFailed }
        : { tone: "muted", icon: "alert", label: copy.evidencePolicyUnknown };

  const testsBadge: EvidenceBadgeSpec =
    evidence.verification === "passed"
      ? { tone: "ok", icon: "check", label: copy.evidenceTestsPassed }
      : evidence.verification === "failed"
        ? { tone: "danger", icon: "alert", label: copy.evidenceTestsFailed }
        : // skipped or none → explicit "검증 없음" so a fake-green never slips through.
          { tone: "warning", icon: "alert", label: copy.evidenceTestsSkipped };

  const targetBadge: EvidenceBadgeSpec | null =
    evidence.targetBranch && expectedTargetBranch
      ? evidence.targetBranch === expectedTargetBranch
        ? { tone: "ok", icon: "branch", label: copy.evidenceTargetMatch }
        : { tone: "danger", icon: "alert", label: copy.evidenceTargetMismatch }
      : null;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{copy.evidenceTitle}</CardTitle>
          <span className="mt-1 block text-[12px] leading-4 text-charcoal">{copy.evidenceSubtitle}</span>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!evidence.present ? (
          <p className="text-[13px] leading-5 text-charcoal">{copy.evidenceNone}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <EvidenceBadge spec={protectedBadge} />
              <EvidenceBadge spec={policyBadge} />
              <EvidenceBadge spec={testsBadge} />
              {targetBadge ? <EvidenceBadge spec={targetBadge} /> : null}
            </div>

            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Fact
                label={copy.evidenceChangedFiles}
                value={copy.evidenceChangedFilesUnit(evidence.changedFileCount)}
              />
              <Fact
                label={copy.evidenceTargetBranch}
                value={evidence.targetBranch ?? expectedTargetBranch ?? copy.empty}
              />
              <div className="min-w-0 rounded-xl border border-hairline-gray bg-linen-white p-3 sm:col-span-2">
                <dt className="mb-2 text-[12px] leading-4 text-charcoal">{copy.evidenceBaseHead}</dt>
                <dd className="m-0 break-all font-mono text-[12px] leading-5 text-true-black">
                  {evidence.baseSha || evidence.headSha
                    ? `${shortSha(evidence.baseSha) ?? "—"}..${shortSha(evidence.headSha) ?? "—"}`
                    : copy.empty}
                </dd>
              </div>
            </dl>

            {/* Changed-file deeplinks (L3): each file links to its diff on the PR's
                Files tab. When pr_url is absent or unparseable, files render as plain
                paths (no broken links). */}
            {shownFiles.length > 0 ? (
              <div>
                <p className="mb-2 text-[12px] leading-4 text-charcoal">{copy.evidenceChangedFilesList}</p>
                <ul className="m-0 grid list-none gap-1.5 p-0" aria-label={copy.evidenceChangedFilesList}>
                  {shownFiles.map((file) => {
                    const href = filesUrl ? prFileDeepLink(filesUrl, fileAnchors[file]) : null;
                    return (
                      <li key={file}>
                        {href ? (
                          <a
                            className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-hairline-gray bg-linen-white px-3 py-1.5 font-mono text-[12px] leading-5 text-cobalt-surface no-underline shadow-sm transition-colors hover:border-electric-blue hover:bg-mist-blue"
                            href={href}
                            rel="noreferrer"
                            target="_blank"
                            title={`${copy.evidenceOpenChangedFile} · ${file}`}
                          >
                            <FileDiff aria-hidden="true" size={13} strokeWidth={2.2} className="shrink-0" />
                            <span className="truncate">{file}</span>
                            <ExternalLink aria-hidden="true" size={12} strokeWidth={2.2} className="shrink-0" />
                          </a>
                        ) : (
                          <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-hairline-gray bg-linen-white px-3 py-1.5 font-mono text-[12px] leading-5 text-true-black">
                            <FileDiff aria-hidden="true" size={13} strokeWidth={2.2} className="shrink-0" />
                            <span className="truncate">{file}</span>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {hiddenFileCount > 0 ? (
                  filesUrl ? (
                    <a
                      className="mt-2 inline-block text-[12px] leading-4 text-cobalt-surface"
                      href={filesUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {copy.evidenceChangedFilesMore(hiddenFileCount)}
                    </a>
                  ) : (
                    <p className="m-0 mt-2 text-[12px] leading-4 text-charcoal">
                      {copy.evidenceChangedFilesMore(hiddenFileCount)}
                    </p>
                  )
                ) : null}
              </div>
            ) : null}

            {evidence.tests.length > 0 ? (
              <ul className="m-0 grid list-none gap-2 p-0" aria-label={copy.evidenceTests}>
                {evidence.tests.map((test, index) => (
                  <li
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-hairline-gray bg-linen-white px-3 py-2"
                    key={`${index}-${test.command}`}
                  >
                    <Badge variant={testStatusVariant(test.status)}>{translateTestStatus(test.status, copy)}</Badge>
                    <code className="break-all font-mono text-[12px] leading-5 text-true-black">{test.command}</code>
                    {test.summary ? (
                      <span className="text-[12px] leading-4 text-charcoal">· {test.summary}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            {evidence.deniedFiles.length > 0 ? (
              <div className="rounded-lg border border-danger bg-danger-wash px-3 py-2">
                <p className="m-0 text-[12px] leading-4 text-danger">{copy.evidenceProtectedList}</p>
                <ul className="m-0 mt-1 list-disc pl-5 text-[12px] leading-5 text-danger">
                  {evidence.deniedFiles.map((file) => (
                    <li className="break-all" key={file}>
                      {file}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {evidenceArtifacts.length > 0 ? (
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={rawOpen}
                  className="h-8 gap-1 px-2 text-[12px] text-graphite"
                  onClick={() => setRawOpen((open) => !open)}
                >
                  <ChevronDown
                    data-icon
                    aria-hidden="true"
                    strokeWidth={2.2}
                    className={rawOpen ? "rotate-180 transition-transform" : "transition-transform"}
                  />
                  {rawOpen ? copy.evidenceHideRaw : copy.evidenceShowRaw}
                </Button>
                {rawOpen ? (
                  <div className="mt-2" data-testid="evidence-raw">
                    <ArtifactPanel
                      artifacts={evidenceArtifacts}
                      totalCount={totalCount}
                      copy={copy}
                      locale={locale}
                      variant="embedded"
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

type EvidenceTone = "ok" | "warning" | "danger" | "muted";
type EvidenceIcon = "shield" | "check" | "alert" | "branch" | "diff";
interface EvidenceBadgeSpec {
  tone: EvidenceTone;
  icon: EvidenceIcon;
  label: string;
}

function EvidenceBadge({ spec }: { spec: EvidenceBadgeSpec }) {
  // Color-independent: every badge carries an icon + text, so meaning survives for
  // color-blind operators and in grayscale.
  const Icon =
    spec.icon === "shield"
      ? ShieldCheck
      : spec.icon === "check"
        ? Check
        : spec.icon === "branch"
          ? GitBranch
          : spec.icon === "diff"
            ? FileDiff
            : AlertTriangle;
  const toneClass =
    spec.tone === "ok"
      ? "border-transparent bg-mist-blue text-forest-ink"
      : spec.tone === "danger"
        ? "border-danger bg-danger-wash text-danger"
        : spec.tone === "warning"
          ? "border-amber-border bg-amber-wash text-amber-ink"
          : "border-hairline-gray bg-linen-white text-charcoal";
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium leading-4 shadow-sm ${toneClass}`}
    >
      <Icon aria-hidden="true" size={13} strokeWidth={2.4} className="shrink-0" />
      <span className="truncate">{spec.label}</span>
    </span>
  );
}

function testStatusVariant(status: string): "default" | "warning" | "danger" | "dark" {
  if (status === "passed") return "dark";
  if (status === "failed") return "danger";
  return "warning";
}

function translateTestStatus(status: string, copy: AdminCopy): string {
  if (status === "passed") return copy.evidenceTestsPassed;
  if (status === "failed") return copy.evidenceTestsFailed;
  return copy.evidenceTestsSkipped;
}

function shortSha(value: string | undefined): string | null {
  if (!value) return null;
  return value.length > 10 ? value.slice(0, 10) : value;
}

function ArtifactPanel({
  artifacts,
  totalCount,
  copy,
  locale,
  variant = "card",
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
          <span className="text-xs text-charcoal">
            {artifacts.length}/{totalCount ?? artifacts.length}
          </span>
        </div>
      </div>
      <div className="grid gap-3 p-4">
        {artifacts.map((artifact, index) => (
          <article
            className="overflow-hidden rounded-xl border border-hairline-gray bg-linen-white"
            key={String(artifact.id ?? `${artifact.kind}-${index}`)}
          >
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
      <section
        className="surface-card-soft rounded-xl border border-hairline-gray bg-linen-white"
        aria-label={copy.artifacts}
      >
        {content}
      </section>
    );
  }

  return <Card>{content}</Card>;
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

  const attempts = events
    .map((event) => parseAttempt(event.attempt))
    .filter((attempt): attempt is number => attempt !== null);
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

function filterEventsForCurrentRun(
  events: RunEvent[],
  currentAttempt: number | null,
  currentRunId: string | null,
): RunEvent[] {
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
  const phaseTimes = phaseEvents
    .map((event) => parseTime(event.created_at))
    .filter((time): time is number => time !== null);
  const startMs = phaseTimes[0] ?? null;
  const lastPhaseMs = phaseTimes[phaseTimes.length - 1] ?? startMs;
  const nextEvent =
    lastPhaseMs === null
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
    label,
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
  return artifacts.filter(
    (artifact) => !hasKnownArtifactPhase(artifact) && isWithinContext(artifact.created_at, context),
  );
}

function artifactMatchesPhase(artifact: Artifact, phase: string): boolean {
  const kind = String(artifact.kind ?? "").toLowerCase();
  if (!kind) return false;
  if (kind.includes("policy")) return phase === "PolicyChecking";
  if (kind.includes("agent-result") || kind.includes("result")) return phase === "Completed";
  if (kind.includes("pr") || kind.includes("publish")) return phase === "Publishing";
  if (kind.includes("ticket") || kind.includes("context") || kind.includes("input"))
    return phase === "Queued" || phase === "Planning";
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
    kind.includes("gstack"),
  );
}

function isWithinContext(value: string | undefined, context: StepContext): boolean {
  const time = parseTime(value);
  if (time === null || context.startMs === null) return false;
  if (time < context.startMs) return false;
  return context.endMs === null ? true : time <= context.endMs;
}

function CopyButton({ value, copy, label }: { value: string; copy: AdminCopy; label?: string }) {
  const [copied, setCopied] = useState(false);
  const title = `${label ? `${label} · ` : ""}${copy.copy}`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 shrink-0 text-graphite"
      aria-label={title}
      title={title}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          },
          () => undefined,
        );
      }}
    >
      {copied ? (
        <Check data-icon aria-hidden="true" strokeWidth={2.2} />
      ) : (
        <Copy data-icon aria-hidden="true" strokeWidth={2.2} />
      )}
    </Button>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="min-w-0 rounded-xl border border-hairline-gray bg-linen-white p-3">
      <dt className="mb-2 text-[12px] leading-4 text-charcoal">{label}</dt>
      <dd className="m-0 break-words text-[13px] leading-5 text-true-black">
        {tone === "danger" && value !== "-" ? <Badge variant="danger">{value}</Badge> : value}
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
    minute: "2-digit",
  }).format(time);
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
