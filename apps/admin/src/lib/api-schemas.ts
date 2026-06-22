// Runtime validators for the admin API client (Phase 3 / G3 of the type-safety
// hardening plan — see docs/type-safety-hardening-plan.md). The admin is a Vite
// browser bundle that does NOT depend on zod or @ticket-to-pr/core, so these are
// small hand-written type guards instead of a schema library: they check the key
// fields of each response shape and return the narrowed value or `null`.
//
// Callers in api.ts treat a `null` here exactly like a malformed/absent response
// and fall back to the existing safe sentinel (METRICS_UNAVAILABLE /
// SETTINGS_UNAVAILABLE / admin_api_unavailable), so a server that drifts from the
// expected shape degrades gracefully instead of letting an unchecked cast leak a
// wrong-typed value into a render.

import type {
  JobMetrics,
  RetryResponse,
  SettingsFieldView,
  SettingsSectionView,
  SettingsView,
  VersionInfo,
} from "../api.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Treats `undefined` as valid (the field may be absent on an older backend) but
// rejects a present-yet-wrong-typed value (e.g. successRate: "fast").
function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalNullableNumber(value: unknown): value is number | null | undefined {
  return value === null || isOptionalNumber(value);
}

/**
 * Validate the GET /api/metrics body. Every field is optional (the consumer renders
 * only what is present), so this accepts any object and only rejects a payload that
 * is not an object or whose *present* fields have the wrong type. Returns the typed
 * value, or `null` so the caller can fall back to METRICS_UNAVAILABLE.
 */
export function parseJobMetrics(value: unknown): JobMetrics | null {
  if (!isRecord(value)) return null;

  if (!isOptionalNumber(value.totalJobs)) return null;
  if (!isOptionalNumber(value.successRate)) return null;
  if (!isOptionalNumber(value.mergeRate)) return null;
  if (!isOptionalNumber(value.retryRate)) return null;

  if (value.runtimeSeconds !== undefined) {
    const runtime = value.runtimeSeconds;
    if (!isRecord(runtime)) return null;
    if (!isOptionalNullableNumber(runtime.p50)) return null;
    if (!isOptionalNullableNumber(runtime.p95)) return null;
    if (!isOptionalNumber(runtime.sampleSize)) return null;
  }

  if (value.executorModeDistribution !== undefined) {
    const dist = value.executorModeDistribution;
    if (!isRecord(dist)) return null;
    for (const count of Object.values(dist)) {
      if (typeof count !== "number" || !Number.isFinite(count)) return null;
    }
  }

  // JobMetrics extends JsonRecord and every named field is optional, so the
  // validated record already satisfies it — no assertion needed (unlike
  // parseRetryResponse / parseSettingsView, whose targets have required fields).
  return value;
}

const FIELD_KINDS = new Set<SettingsFieldView["kind"]>(["string", "int", "bool", "csv", "enum"]);
const FIELD_APPLIES = new Set<SettingsFieldView["applies"]>(["live", "restart"]);
const FIELD_SOURCES = new Set<SettingsFieldView["source"]>(["override", "env", "default"]);

function isSettingsField(value: unknown): value is SettingsFieldView {
  if (!isRecord(value)) return false;
  if (typeof value.key !== "string") return false;
  if (typeof value.editable !== "boolean") return false;
  if (typeof value.kind !== "string" || !FIELD_KINDS.has(value.kind as SettingsFieldView["kind"])) return false;
  if (typeof value.applies !== "string" || !FIELD_APPLIES.has(value.applies as SettingsFieldView["applies"])) {
    return false;
  }
  if (typeof value.source !== "string" || !FIELD_SOURCES.has(value.source as SettingsFieldView["source"])) {
    return false;
  }
  // `value` is intentionally `unknown` in the type, so any value is acceptable.
  return true;
}

function isSettingsSection(value: unknown): value is SettingsSectionView {
  if (!isRecord(value)) return false;
  if (typeof value.key !== "string") return false;
  if (!Array.isArray(value.fields)) return false;
  return value.fields.every(isSettingsField);
}

/**
 * Validate the GET/PUT /api/settings body. The consumer iterates
 * `view.sections[].fields[]` and reads `key`/`editable`/`kind`/`value`, so those are
 * the load-bearing fields checked here. Returns the typed value, or `null` so the
 * caller can fall back to SETTINGS_UNAVAILABLE / admin_api_unavailable.
 */
export function parseSettingsView(value: unknown): SettingsView | null {
  if (!isRecord(value)) return null;
  const { sections } = value;
  if (!Array.isArray(sections)) return null;
  // `every` with the type-guard predicate narrows `sections` to
  // SettingsSectionView[], so the returned object is built from validated data
  // with no assertion.
  if (!sections.every(isSettingsSection)) return null;
  return { sections };
}

/**
 * Structural guard for endpoints whose body is a JSON array of records (jobs,
 * events, logs, artifacts). The element types are open `JsonRecord` extensions whose
 * fields are all optional, so the meaningful runtime invariant is "the top level is
 * an array of objects" — anything else (an object, a string, an array of scalars)
 * is the wrong shape and falls back to admin_api_unavailable. The cast is safe
 * because every element is verified to be a non-null object.
 */
export function parseRecordArray<T extends Record<string, unknown>>(value: unknown): T[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every(isRecord)) return null;
  return value as T[];
}

/**
 * Structural guard for endpoints whose body is a single JSON object (a job, a cancel
 * ack). Same rationale as parseRecordArray: the field set is open, so the runtime
 * invariant we enforce is "the top level is a non-null, non-array object".
 */
export function parseRecord<T extends Record<string, unknown>>(value: unknown): T | null {
  if (!isRecord(value)) return null;
  return value as T;
}

/**
 * Validate a POST .../retry or .../answer body. All three fields are required by the
 * consumer (it shows the new run id + attempt), so a missing/wrong-typed field is
 * rejected. Returns the typed value, or `null` so the caller can fall back to
 * admin_api_unavailable.
 */
export function parseRetryResponse(value: unknown): RetryResponse | null {
  if (!isRecord(value)) return null;
  const { ok, runId, attempt } = value;
  if (typeof ok !== "boolean") return null;
  if (typeof runId !== "string") return null;
  if (typeof attempt !== "number" || !Number.isFinite(attempt)) return null;
  return { ok, runId, attempt };
}

/**
 * Validate a POST .../cancel acknowledgement: `{ ok: boolean; phase: string }`. Both
 * fields are read by the caller, so a missing/wrong-typed one is rejected and the
 * caller falls back to admin_api_unavailable.
 */
export function parseCancelResponse(value: unknown): { ok: boolean; phase: string } | null {
  if (!isRecord(value)) return null;
  const { ok, phase } = value;
  if (typeof ok !== "boolean") return null;
  if (typeof phase !== "string") return null;
  return { ok, phase };
}

/**
 * Validate the GET /api/version body: `{ version: string; sha: string | null }`. Both
 * fields are read by the badge (version always shown; sha shortened when present), so a
 * missing/wrong-typed `version` or a `sha` that is neither string nor null is rejected.
 * Returns the typed value, or `null` so the caller can fall back to VERSION_UNAVAILABLE.
 */
export function parseVersionInfo(value: unknown): VersionInfo | null {
  if (!isRecord(value)) return null;
  const { version, sha, nodeEnv, executorMode, publisherMode, publicBaseUrl } = value;
  if (typeof version !== "string") return null;
  if (sha !== null && typeof sha !== "string") return null;
  if (nodeEnv !== undefined && typeof nodeEnv !== "string") return null;
  if (executorMode !== undefined && typeof executorMode !== "string") return null;
  if (publisherMode !== undefined && typeof publisherMode !== "string") return null;
  if (publicBaseUrl !== undefined && publicBaseUrl !== null && typeof publicBaseUrl !== "string") return null;
  const parsed: VersionInfo = { version, sha };
  if (nodeEnv !== undefined) parsed.nodeEnv = nodeEnv;
  if (executorMode !== undefined) parsed.executorMode = executorMode;
  if (publisherMode !== undefined) parsed.publisherMode = publisherMode;
  if (publicBaseUrl !== undefined) parsed.publicBaseUrl = publicBaseUrl;
  return parsed;
}
