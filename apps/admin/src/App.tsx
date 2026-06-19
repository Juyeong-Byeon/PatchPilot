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

interface DetailState {
  job: JobRecord | null;
  events: RunEvent[];
  logs: LogLine[];
  artifacts: Artifact[];
}

const emptyDetail: DetailState = {
  job: null,
  events: [],
  logs: [],
  artifacts: []
};

export default function App() {
  const [token, setToken] = useState(() => getStoredAdminToken());
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>("");
  const [detail, setDetail] = useState<DetailState>(emptyDetail);
  const [isLoadingJobs, setIsLoadingJobs] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [status, setStatus] = useState<string>(token ? "Ready" : "Enter ADMIN_TOKEN to load jobs.");
  const [error, setError] = useState<string>("");
  const [actionState, setActionState] = useState<string>("");

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? detail.job,
    [detail.job, jobs, selectedJobId]
  );

  useEffect(() => {
    if (!token) return;
    void refreshJobs(token);
  }, [token]);

  useEffect(() => {
    if (!selectedJobId || !token) {
      setDetail(emptyDetail);
      return;
    }

    void refreshDetail(selectedJobId, token);
  }, [selectedJobId, token]);

  async function refreshJobs(activeToken = token) {
    if (!activeToken.trim()) {
      setStatus("Enter ADMIN_TOKEN to load jobs.");
      return;
    }

    setIsLoadingJobs(true);
    setError("");
    try {
      const nextJobs = await fetchJobs(activeToken);
      setJobs(nextJobs);
      setSelectedJobId((current) => current || nextJobs[0]?.id || "");
      setStatus(`Loaded ${nextJobs.length} job${nextJobs.length === 1 ? "" : "s"}.`);
    } catch (caught) {
      setError(errorMessage(caught));
      setStatus("Job refresh failed.");
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
      setError(errorMessage(caught));
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
        setStatus(`Retry queued as attempt ${retry.attempt}.`);
      } else {
        const cancel = await cancelJob(selectedJobId, token);
        setStatus(`Cancel requested: ${cancel.phase}.`);
      }
      await refreshJobs(token);
      await refreshDetail(selectedJobId, token);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setActionState("");
    }
  }

  return (
    <main className="ops-shell">
      <header className="ops-header">
        <div>
          <p className="eyebrow">Admin Console</p>
          <h1>Ticket-to-PR Operations</h1>
        </div>
        <form
          className="token-form"
          onSubmit={(event) => {
            event.preventDefault();
            saveToken();
          }}
        >
          <label htmlFor="admin-token">ADMIN_TOKEN</label>
          <input
            id="admin-token"
            value={token}
            type="password"
            autoComplete="off"
            placeholder="Bearer token"
            onChange={(event) => setToken(event.target.value)}
          />
          <button type="submit">Apply</button>
          <button type="button" onClick={() => void refreshJobs(token)}>
            Refresh
          </button>
        </form>
      </header>

      <section className="status-strip" aria-live="polite">
        <span>{status}</span>
        {error ? <strong>{error}</strong> : null}
      </section>

      <section className="ops-grid">
        <JobList
          jobs={jobs}
          selectedJobId={selectedJobId}
          isLoading={isLoadingJobs}
          onSelectJob={setSelectedJobId}
        />
        <JobDetail
          job={selectedJob}
          events={detail.events}
          logs={detail.logs}
          artifacts={detail.artifacts}
          isLoading={isLoadingDetail}
          actionState={actionState}
          onCancel={() => void runAction("cancel")}
          onRetry={() => void runAction("retry")}
        />
      </section>
    </main>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
