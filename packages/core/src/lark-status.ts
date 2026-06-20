export interface LarkStatusUpdate {
  recordId: string;
  status: string;
  jobId?: string;
  prUrl?: string;
  prNumber?: number;
  failureReason?: string;
}

export interface LarkStatusFieldMapping {
  statusField: string;
  jobIdField?: string;
  prUrlField?: string;
  prNumberField?: string;
  failureReasonField?: string;
  updatedAtField?: string;
}

export interface LarkRecordUpdaterConfig {
  appId: string;
  appSecret: string;
  baseAppToken: string;
  tableId: string;
  apiBaseUrl: string;
  fieldMapping: LarkStatusFieldMapping;
}

export type LarkStatusUpdater = (update: LarkStatusUpdate) => Promise<void>;

interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponse>;

export function readLarkRecordUpdaterConfig(source: Record<string, string | undefined>): LarkRecordUpdaterConfig | undefined {
  const appId = clean(source.LARK_APP_ID);
  const appSecret = clean(source.LARK_APP_SECRET);
  const baseAppToken = clean(source.LARK_BASE_APP_TOKEN);
  const tableId = clean(source.LARK_BASE_TABLE_ID);
  const configured = [appId, appSecret, baseAppToken, tableId].some(Boolean);
  if (!configured) return undefined;

  const missing = [
    ["LARK_APP_ID", appId],
    ["LARK_APP_SECRET", appSecret],
    ["LARK_BASE_APP_TOKEN", baseAppToken],
    ["LARK_BASE_TABLE_ID", tableId]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) throw new Error(`Incomplete Lark status update config: ${missing.join(", ")}`);

  return {
    appId: appId!,
    appSecret: appSecret!,
    baseAppToken: baseAppToken!,
    tableId: tableId!,
    apiBaseUrl: clean(source.LARK_API_BASE_URL) ?? "https://open.larksuite.com",
    fieldMapping: {
      statusField: clean(source.LARK_STATUS_FIELD) ?? "PatchPilot Status",
      jobIdField: clean(source.LARK_JOB_ID_FIELD) ?? "PatchPilot Job ID",
      prUrlField: clean(source.LARK_PR_URL_FIELD) ?? "PR URL",
      prNumberField: clean(source.LARK_PR_NUMBER_FIELD) ?? "PR Number",
      failureReasonField: clean(source.LARK_FAILURE_FIELD) ?? "PatchPilot Failure",
      updatedAtField: clean(source.LARK_UPDATED_AT_FIELD) ?? "PatchPilot Updated At"
    }
  };
}

export function createLarkRecordUpdater(config: LarkRecordUpdaterConfig, fetchImpl: FetchLike = defaultFetch): LarkStatusUpdater {
  let cachedToken: { value: string; expiresAtMs: number } | null = null;

  return async (update) => {
    const token = await getTenantAccessToken(config, fetchImpl, cachedToken);
    cachedToken = token;
    const fields = buildLarkRecordFields(update, config.fieldMapping);
    const response = await fetchImpl(
      `${trimTrailingSlash(config.apiBaseUrl)}/open-apis/bitable/v1/apps/${encodeURIComponent(config.baseAppToken)}/tables/${encodeURIComponent(config.tableId)}/records/${encodeURIComponent(update.recordId)}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token.value}`,
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({ fields })
      }
    );
    if (!response.ok) {
      throw new Error(`Lark record update failed with status ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { code?: number; msg?: string };
    if (body.code !== undefined && body.code !== 0) {
      throw new Error(`Lark record update failed: ${body.msg ?? `code ${body.code}`}`);
    }
  };
}

export function buildLarkRecordFields(update: LarkStatusUpdate, mapping: LarkStatusFieldMapping): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    [mapping.statusField]: update.status
  };
  if (mapping.jobIdField && update.jobId) fields[mapping.jobIdField] = update.jobId;
  if (mapping.prUrlField && update.prUrl) fields[mapping.prUrlField] = update.prUrl;
  if (mapping.prNumberField && update.prNumber !== undefined) fields[mapping.prNumberField] = update.prNumber;
  if (mapping.failureReasonField && update.failureReason) fields[mapping.failureReasonField] = update.failureReason;
  if (mapping.updatedAtField) fields[mapping.updatedAtField] = new Date().toISOString();
  return fields;
}

async function getTenantAccessToken(
  config: LarkRecordUpdaterConfig,
  fetchImpl: FetchLike,
  cachedToken: { value: string; expiresAtMs: number } | null
): Promise<{ value: string; expiresAtMs: number }> {
  if (cachedToken && cachedToken.expiresAtMs > Date.now() + 60_000) return cachedToken;

  const response = await fetchImpl(`${trimTrailingSlash(config.apiBaseUrl)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: config.appId,
      app_secret: config.appSecret
    })
  });
  if (!response.ok) throw new Error(`Lark tenant token request failed with status ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`Lark tenant token request failed: ${body.msg ?? `code ${body.code ?? "unknown"}`}`);
  }
  return {
    value: body.tenant_access_token,
    expiresAtMs: Date.now() + Math.max(60, body.expire ?? 7200) * 1000
  };
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}
