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
  pr_url?: string | null;
  last_event?: string | null;
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
