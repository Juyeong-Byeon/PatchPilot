export type JsonRecord = Record<string, unknown>;

export interface JobRecord extends JsonRecord {
  id: string;
  phase?: string;
  outcome?: string;
  priority?: string;
  repository?: string;
  target_branch?: string;
  targetBranch?: string;
  work_branch?: string;
  workBranch?: string;
  attempt?: number;
  created_at?: string;
  updated_at?: string;
  failure_category?: string | null;
  failure_reason?: string | null;
  next_action?: string | null;
  // The agent's blocking question while the job is parked at NeedsInput (입력 대기).
  // Returned by getJob; null/absent for every job that is not awaiting input.
  pending_question?: string | null;
  pr_url?: string | null;
  last_event?: string | null;
  // Ticket context joined in by getJob (ticket_snapshots). Both snake_case (raw
  // API rows) and camelCase (worker-shaped records) are accepted so callers never
  // depend on which serializer produced the record.
  title?: string | null;
  description?: string | null;
  definition_of_done?: string | null;
  definitionOfDone?: string | null;
  raw_fields?: JsonRecord | null;
  rawFields?: JsonRecord | null;
  // Forward-compat: the executor/pipeline mode (single-pass vs staged) is added by
  // a separate backend track. Rendered only when present; never required.
  executor_mode?: string | null;
  executorMode?: string | null;
  pipeline_mode?: string | null;
  pipelineMode?: string | null;
}

export interface RunEvent extends JsonRecord {
  id?: number | string;
  job_id?: string;
  run_id?: string | null;
  attempt?: number | null;
  phase?: string;
  event_type?: string;
  eventType?: string;
  source?: string;
  message?: string;
  created_at?: string;
  metadata?: unknown;
}

export interface LogLine extends JsonRecord {
  id?: number | string;
  job_id?: string;
  run_id?: string | null;
  source?: string;
  stream?: string;
  sequence?: number;
  redaction_applied?: boolean;
  text?: string;
  created_at?: string;
}

export interface Artifact extends JsonRecord {
  id?: string;
  job_id?: string;
  run_id?: string | null;
  kind?: string;
  path?: string | null;
  content?: unknown;
  created_at?: string;
}

export interface RetryResponse {
  ok: boolean;
  runId: string;
  attempt: number;
}

// Shape of GET /api/metrics (backend `MetricsSummary`). Every field is optional so
// the consumer renders only what is present and degrades if the endpoint predates a
// field. Rates are 0..1 fractions; `runtimeSeconds` durations are in seconds.
export interface JobMetrics extends JsonRecord {
  totalJobs?: number;
  successRate?: number;
  mergeRate?: number;
  retryRate?: number;
  runtimeSeconds?: { p50?: number | null; p95?: number | null; sampleSize?: number };
  // Executor/pipeline mode → job count, e.g. { singlePass: 12, staged: 3, unknown: 0 }.
  executorModeDistribution?: Record<string, number>;
}

// Sentinel thrown when /api/metrics is absent (404). Lets the caller distinguish
// "feature not deployed → hide the panel silently" from a transient/auth error.
export const METRICS_UNAVAILABLE = "admin_metrics_unavailable";

// Shape of GET/PUT /api/settings. The backend resolves env ⊕ override and groups by
// section, omitting secret fields entirely. Every field is optional so the consumer
// degrades gracefully if the endpoint predates a field.
export interface SettingsFieldView {
  key: string;
  value: unknown;
  editable: boolean;
  kind: "string" | "int" | "bool" | "csv" | "enum";
  applies: "live" | "restart";
  source: "override" | "env" | "default";
  enumValues?: string[];
  min?: number;
  max?: number;
}

export interface SettingsSectionView {
  key: string;
  fields: SettingsFieldView[];
}

export interface SettingsView {
  sections: SettingsSectionView[];
}

// Sentinel thrown when /api/settings is absent (404) on an older backend. Lets the
// Settings page hide/disable itself gracefully instead of surfacing a broken screen.
export const SETTINGS_UNAVAILABLE = "admin_settings_unavailable";

const TOKEN_STORAGE_KEY = "ADMIN_TOKEN";
const API_BASE_URL = (import.meta.env.VITE_ADMIN_API_BASE_URL ?? "").replace(/\/$/, "");

export function getStoredAdminToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeAdminToken(token: string): void {
  try {
    if (token.trim()) {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
    } else {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Storage can be blocked in hardened browsers; callers still keep token in memory.
  }
}

export async function fetchJobs(token = getStoredAdminToken()): Promise<JobRecord[]> {
  return adminRequest<JobRecord[]>("/api/jobs", { token });
}

export async function fetchJob(jobId: string, token = getStoredAdminToken()): Promise<JobRecord> {
  return adminRequest<JobRecord>(`/api/jobs/${encodeURIComponent(jobId)}`, { token });
}

export async function fetchJobEvents(jobId: string, token = getStoredAdminToken()): Promise<RunEvent[]> {
  return adminRequest<RunEvent[]>(`/api/jobs/${encodeURIComponent(jobId)}/events`, { token });
}

export async function fetchJobLogs(jobId: string, token = getStoredAdminToken()): Promise<LogLine[]> {
  return adminRequest<LogLine[]>(`/api/jobs/${encodeURIComponent(jobId)}/logs`, { token });
}

export async function fetchJobArtifacts(jobId: string, token = getStoredAdminToken()): Promise<Artifact[]> {
  return adminRequest<Artifact[]>(`/api/jobs/${encodeURIComponent(jobId)}/artifacts`, { token });
}

export async function cancelJob(jobId: string, token = getStoredAdminToken()): Promise<{ ok: boolean; phase: string }> {
  return adminRequest<{ ok: boolean; phase: string }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    token,
  });
}

export async function retryJob(jobId: string, token = getStoredAdminToken()): Promise<RetryResponse> {
  return adminRequest<RetryResponse>(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
    token,
  });
}

/**
 * Answer a parked NeedsInput job (입력 대기): POST the operator's answer, which the
 * backend injects as the new run's guidance and re-enqueues (a fresh attempt). 401
 * maps to the shared session-expiry sentinel so the re-auth boundary stays
 * centralized; any other non-OK surfaces the backend message (e.g. a 409 if the job
 * is no longer awaiting input). Returns the new run id + attempt like a retry.
 */
export async function answerJob(jobId: string, answer: string, token = getStoredAdminToken()): Promise<RetryResponse> {
  const trimmed = token?.trim();
  if (!trimmed) throw new Error("admin_access_key_required");

  const response = await fetch(`${API_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/answer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${trimmed}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ answer }),
  });

  if (response.status === 401) throw new Error("admin_access_key_invalid");
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${response.status} ${response.statusText}${message ? `: ${message}` : ""}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new Error("admin_api_unavailable");

  try {
    return (await response.json()) as RetryResponse;
  } catch {
    throw new Error("admin_api_unavailable");
  }
}

/**
 * Fetch operations metrics. Defensive by design: the endpoint is shipped by a
 * separate track and may not exist yet. A 404 (or a route that answers with
 * non-JSON, e.g. an SPA fallback) throws `METRICS_UNAVAILABLE` so the dashboard can
 * hide itself silently instead of surfacing a broken panel. 401 still maps to the
 * shared session-expiry sentinel so the re-auth boundary stays centralized.
 */
export async function fetchMetrics(token = getStoredAdminToken()): Promise<JobMetrics> {
  const trimmed = token?.trim();
  if (!trimmed) throw new Error("admin_access_key_required");

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/metrics`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${trimmed}`,
        Accept: "application/json",
      },
    });
  } catch {
    // Network error — treat as unavailable so the panel stays hidden rather than erroring.
    throw new Error(METRICS_UNAVAILABLE);
  }

  if (response.status === 401) throw new Error("admin_access_key_invalid");
  if (response.status === 404) throw new Error(METRICS_UNAVAILABLE);
  if (!response.ok) throw new Error(METRICS_UNAVAILABLE);

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new Error(METRICS_UNAVAILABLE);

  try {
    return (await response.json()) as JobMetrics;
  } catch {
    throw new Error(METRICS_UNAVAILABLE);
  }
}

/**
 * Fetch the effective configuration (env ⊕ override), grouped by section. Defensive:
 * the endpoint is shipped by this track and may not exist on an older backend, so a
 * 404 (or a non-JSON SPA fallback) throws `SETTINGS_UNAVAILABLE` and the page hides
 * itself. 401 maps to the shared session-expiry sentinel.
 */
export async function fetchSettings(token = getStoredAdminToken()): Promise<SettingsView> {
  const trimmed = token?.trim();
  if (!trimmed) throw new Error("admin_access_key_required");

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/settings`, {
      method: "GET",
      headers: { Authorization: `Bearer ${trimmed}`, Accept: "application/json" },
    });
  } catch {
    throw new Error(SETTINGS_UNAVAILABLE);
  }

  if (response.status === 401) throw new Error("admin_access_key_invalid");
  if (response.status === 404) throw new Error(SETTINGS_UNAVAILABLE);
  if (!response.ok) throw new Error(SETTINGS_UNAVAILABLE);

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new Error(SETTINGS_UNAVAILABLE);

  try {
    return (await response.json()) as SettingsView;
  } catch {
    throw new Error(SETTINGS_UNAVAILABLE);
  }
}

/**
 * Persist editable setting overrides and return the new effective config. A 400 from
 * the backend (non-editable key / invalid value) surfaces its message so the page can
 * show what went wrong; 401 maps to the shared session-expiry sentinel.
 */
export async function updateSettings(
  updates: Record<string, unknown>,
  token = getStoredAdminToken(),
): Promise<SettingsView> {
  const trimmed = token?.trim();
  if (!trimmed) throw new Error("admin_access_key_required");

  const response = await fetch(`${API_BASE_URL}/api/settings`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${trimmed}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ updates }),
  });

  if (response.status === 401) throw new Error("admin_access_key_invalid");
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${response.status} ${response.statusText}${message ? `: ${message}` : ""}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new Error("admin_api_unavailable");

  try {
    return (await response.json()) as SettingsView;
  } catch {
    throw new Error("admin_api_unavailable");
  }
}

async function adminRequest<T>(path: string, options: { method?: "GET" | "POST"; token?: string } = {}): Promise<T> {
  const token = options.token?.trim();
  if (!token) throw new Error("admin_access_key_required");

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error("admin_access_key_invalid");
    const message = await response.text();
    throw new Error(`${response.status} ${response.statusText}${message ? `: ${message}` : ""}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new Error("admin_api_unavailable");

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error("admin_api_unavailable");
  }
}
