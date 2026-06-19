import type { Artifact, JobRecord, LogLine, RunEvent } from "../api.js";
import { LogViewer } from "./LogViewer.js";
import { RunTimeline } from "./RunTimeline.js";

interface JobDetailProps {
  job: JobRecord | null;
  events: RunEvent[];
  logs: LogLine[];
  artifacts: Artifact[];
  isLoading: boolean;
  actionState: string;
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
  onRetry,
  onCancel
}: JobDetailProps) {
  if (!job) {
    return (
      <section className="panel detail-panel empty-detail">
        <h2>Job Detail</h2>
        <p>{isLoading ? "Loading job detail..." : "Select a job to inspect runtime state."}</p>
      </section>
    );
  }
  const terminal = isTerminalPhase(job.phase);
  const retryDisabled = Boolean(actionState) || !terminal;
  const cancelDisabled = Boolean(actionState) || terminal;

  return (
    <section className="detail-stack">
      <section className="panel detail-panel">
        <div className="detail-header">
          <div>
            <p className="mono muted">{job.id}</p>
            <h2>{job.outcome ?? "Unknown"} / {job.phase ?? "Unknown"}</h2>
          </div>
          <div className="detail-actions">
            <button type="button" disabled={retryDisabled} onClick={onRetry}>
              {actionState === "retry" ? "Retrying" : "Retry"}
            </button>
            <button type="button" disabled={cancelDisabled} onClick={onCancel}>
              {actionState === "cancel" ? "Cancelling" : "Cancel"}
            </button>
          </div>
        </div>

        <dl className="facts-grid">
          <Fact label="Repository" value={stringValue(job.repository)} />
          <Fact label="Target" value={stringValue(job.target_branch ?? job.targetBranch)} />
          <Fact label="Work Branch" value={stringValue(job.work_branch ?? job.workBranch)} />
          <Fact label="Priority" value={stringValue(job.priority)} />
          <Fact label="Attempt" value={stringValue(job.attempt)} />
          <Fact label="Updated" value={formatDate(job.updated_at)} />
          <Fact label="Failure" value={stringValue(job.failure_category)} tone="danger" />
          <Fact label="Next Action" value={stringValue(job.next_action)} />
        </dl>

        {job.failure_reason ? <p className="error-summary">{job.failure_reason}</p> : null}
      </section>

      <RunTimeline events={events} />

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Artifacts</h2>
            <span>{artifacts.length}</span>
          </div>
        </div>
        <div className="artifact-grid">
          {artifacts.map((artifact, index) => (
            <article className="artifact" key={String(artifact.id ?? `${artifact.kind}-${index}`)}>
              <header>
                <strong>{artifact.kind ?? "artifact"}</strong>
                <span>{formatDate(artifact.created_at)}</span>
              </header>
              <p className="mono">{artifact.path ?? "inline content"}</p>
              {artifact.content ? <pre>{formatJson(artifact.content)}</pre> : null}
            </article>
          ))}
          {artifacts.length === 0 ? <p className="empty-copy">No artifacts recorded.</p> : null}
        </div>
      </section>

      <LogViewer logs={logs} />
    </section>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className={tone === "danger" && value !== "-" ? "fact danger" : "fact"}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function isTerminalPhase(phase: unknown): boolean {
  return phase === "Completed" || phase === "Failed" || phase === "Cancelled" || phase === "CancelFailed";
}

function formatDate(value: string | undefined): string {
  if (!value) return "-";
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Intl.DateTimeFormat(undefined, {
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
