// Single source of truth for PatchPilot's operator-facing configuration.
//
// Today every setting is read from env once at process start (apps/worker/src/env.ts,
// apps/api/src/env.ts). The Settings page adds a DB-override layer on top: an
// editable value can be changed in app_settings without a redeploy, and the worker
// resolves the EFFECTIVE value (env ⊕ override) per job / per sweep. This registry
// describes every displayable setting, how to parse/validate an override, and how to
// merge env defaults with overrides into one effective view.
//
// Invariants:
//  - `secret: true` fields are NEVER emitted in display/effective output (masked).
//  - only `editable: true` fields may be written through the override layer; the
//    API gates writes on EDITABLE_KEYS.
//  - security fields (allowlist / denylist) are read-only by design in v1: an
//    operator must not be able to widen the security posture from the console.

export type SettingSection = "modes" | "security" | "execution" | "lifecycle" | "integration" | "runtime";

export type SettingKind = "string" | "int" | "bool" | "csv" | "enum";

/** When an override takes effect: immediately on the next job/sweep, or at next worker restart. */
export type SettingApplies = "live" | "restart";

export interface SettingField {
  /** Stable registry key, also the app_settings.key and the override map key. */
  key: string;
  section: SettingSection;
  /** Whether the value may be changed through the override layer (PUT /api/settings). */
  editable: boolean;
  kind: SettingKind;
  /**
   * Env var names that source this setting's default, in precedence order (first
   * present wins) — mirrors how env.ts reads them (e.g. WORKER_* before the bare name).
   */
  envKeys: string[];
  /** Allowed values for `kind: "enum"`. */
  enumValues?: readonly string[];
  /** When an override takes effect. Read-only fields are "live" (display only). */
  applies: SettingApplies;
  /** Secret fields are never emitted to display output (omitted/masked). */
  secret?: boolean;
  /** Inclusive numeric range for `kind: "int"` overrides. */
  min?: number;
  max?: number;
  /**
   * Default applied when neither an override nor any env key is present. Used to
   * resolve the effective value with source "default".
   */
  default?: string | number | boolean | string[];
}

export type SettingSource = "override" | "env" | "default";

export interface ResolvedSetting {
  value: unknown;
  source: SettingSource;
}

export type EnvSource = Record<string, string | undefined>;

/**
 * The settings registry. Env var names are verified against apps/worker/src/env.ts
 * and the README. Defaults mirror env.ts so the resolved "default" source matches
 * runtime behavior when nothing is configured.
 */
export const SETTINGS_FIELDS: readonly SettingField[] = [
  // ── modes (read-only) ──────────────────────────────────────────────────────
  {
    key: "executorMode",
    section: "modes",
    editable: false,
    kind: "enum",
    envKeys: ["WORKER_EXECUTOR_MODE", "EXECUTOR_MODE"],
    enumValues: ["mock", "gstack"],
    applies: "restart",
    default: "mock",
  },
  {
    key: "publisherMode",
    section: "modes",
    editable: false,
    kind: "enum",
    envKeys: ["WORKER_PUBLISHER_MODE", "PUBLISHER_MODE"],
    enumValues: ["mock", "github"],
    applies: "restart",
    default: "mock",
  },

  // ── security (read-only by design — operator MUST NOT widen these in v1) ────
  {
    key: "repositoryAllowlist",
    section: "security",
    editable: false,
    kind: "csv",
    envKeys: ["POLICY_REPOSITORY_ALLOWLIST", "REPOSITORY_ALLOWLIST"],
    applies: "restart",
    default: [],
  },
  {
    key: "protectedPathDenylist",
    section: "security",
    editable: false,
    kind: "csv",
    envKeys: ["POLICY_PROTECTED_PATH_DENYLIST", "PROTECTED_PATH_DENYLIST"],
    applies: "restart",
    default: [],
  },

  // ── execution (editable, live) ─────────────────────────────────────────────
  {
    key: "jobTimeoutSeconds",
    section: "execution",
    editable: true,
    kind: "int",
    envKeys: ["WORKER_JOB_TIMEOUT_SECONDS", "JOB_TIMEOUT_SECONDS"],
    applies: "live",
    min: 60,
    max: 86400,
    default: 3600,
  },
  // ── lifecycle ──────────────────────────────────────────────────────────────
  {
    // Editable, applies live: read each sweep tick so retention changes apply
    // without a restart.
    key: "failedWorkspaceRetentionDays",
    section: "lifecycle",
    editable: true,
    kind: "int",
    envKeys: ["FAILED_WORKSPACE_RETENTION_DAYS"],
    applies: "live",
    min: 0,
    max: 3650,
    default: 7,
  },
  {
    // Editable, applies at restart: pollers are not restarted live in v1.
    key: "reconcileIntervalMs",
    section: "lifecycle",
    editable: true,
    kind: "int",
    envKeys: ["WORKER_RECONCILE_INTERVAL_MS"],
    applies: "restart",
    min: 0,
    max: 86_400_000,
    default: 60_000,
  },
  {
    key: "runHeartbeatIntervalMs",
    section: "lifecycle",
    editable: true,
    kind: "int",
    envKeys: ["WORKER_RUN_HEARTBEAT_INTERVAL_MS"],
    applies: "restart",
    min: 0,
    max: 86_400_000,
    default: 30_000,
  },
  {
    key: "workspaceSweepIntervalMs",
    section: "lifecycle",
    editable: true,
    kind: "int",
    envKeys: ["WORKER_WORKSPACE_SWEEP_INTERVAL_MS"],
    applies: "restart",
    min: 0,
    max: 86_400_000,
    default: 3_600_000,
  },

  // ── integration (read-only) — Lark field mapping ───────────────────────────
  {
    key: "larkStatusField",
    section: "integration",
    editable: false,
    kind: "string",
    envKeys: ["LARK_STATUS_FIELD"],
    applies: "restart",
    default: "PatchPilot Status",
  },
  {
    key: "larkJobIdField",
    section: "integration",
    editable: false,
    kind: "string",
    envKeys: ["LARK_JOB_ID_FIELD"],
    applies: "restart",
    default: "PatchPilot Job ID",
  },
  {
    key: "larkPrUrlField",
    section: "integration",
    editable: false,
    kind: "string",
    envKeys: ["LARK_PR_URL_FIELD"],
    applies: "restart",
    default: "PR URL",
  },

  // ── runtime (read-only) ────────────────────────────────────────────────────
  {
    key: "runnerImage",
    section: "runtime",
    editable: false,
    kind: "string",
    envKeys: ["GSTACK_RUNNER_IMAGE", "RUNNER_IMAGE"],
    applies: "restart",
    default: "ticket-to-pr-runner:latest",
  },
  {
    // Build/version stamp. Read from GIT_SHA if the process is given one (the
    // Docker images carry it as a LABEL/ARG); omitted from display when absent.
    key: "gitSha",
    section: "runtime",
    editable: false,
    kind: "string",
    envKeys: ["GIT_SHA", "APP_GIT_SHA"],
    applies: "restart",
  },
] as const;

/** Keys an override may write — the API rejects any PUT key not in this set. */
export const EDITABLE_KEYS: readonly string[] = SETTINGS_FIELDS.filter((field) => field.editable).map(
  (field) => field.key,
);

const FIELD_BY_KEY = new Map<string, SettingField>(SETTINGS_FIELDS.map((field) => [field.key, field]));

export function getSettingField(key: string): SettingField | undefined {
  return FIELD_BY_KEY.get(key);
}

/** True for fields whose value must never appear in display/effective output. */
export function isSecretField(field: SettingField): boolean {
  return field.secret === true;
}

/**
 * Parse a raw override value (typically JSON-ish from the API body) into the field's
 * typed value. Throws on a type mismatch so the API can answer 400. The raw value
 * may already be the typed form (an int/bool/array from JSON) or a string.
 */
export function parseSettingValue(field: SettingField, raw: unknown): unknown {
  switch (field.kind) {
    case "int": {
      const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
      if (!Number.isFinite(num) || !Number.isInteger(num)) {
        throw new SettingValidationError(field.key, `${field.key} must be an integer`);
      }
      return num;
    }
    case "bool": {
      if (typeof raw === "boolean") return raw;
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new SettingValidationError(field.key, `${field.key} must be a boolean`);
    }
    case "csv": {
      if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
      if (typeof raw === "string")
        return raw
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
      throw new SettingValidationError(field.key, `${field.key} must be a CSV string or array`);
    }
    case "enum":
    case "string": {
      if (typeof raw !== "string") {
        throw new SettingValidationError(field.key, `${field.key} must be a string`);
      }
      return raw.trim();
    }
    default:
      throw new SettingValidationError(field.key, `Unknown setting kind for ${field.key}`);
  }
}

/**
 * Validate a parsed value against the field's constraints (range / enum / non-empty).
 * Throws SettingValidationError on failure so the API can answer 400 with a message.
 */
export function validateSettingValue(field: SettingField, value: unknown): void {
  switch (field.kind) {
    case "int": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new SettingValidationError(field.key, `${field.key} must be an integer`);
      }
      if (field.min !== undefined && value < field.min) {
        throw new SettingValidationError(field.key, `${field.key} must be >= ${field.min}`);
      }
      if (field.max !== undefined && value > field.max) {
        throw new SettingValidationError(field.key, `${field.key} must be <= ${field.max}`);
      }
      return;
    }
    case "bool": {
      if (typeof value !== "boolean") {
        throw new SettingValidationError(field.key, `${field.key} must be a boolean`);
      }
      return;
    }
    case "enum": {
      if (typeof value !== "string" || !(field.enumValues ?? []).includes(value)) {
        throw new SettingValidationError(
          field.key,
          `${field.key} must be one of: ${(field.enumValues ?? []).join(", ")}`,
        );
      }
      return;
    }
    case "csv": {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new SettingValidationError(field.key, `${field.key} must be a list of strings`);
      }
      return;
    }
    case "string": {
      if (typeof value !== "string" || value.length === 0) {
        throw new SettingValidationError(field.key, `${field.key} must be a non-empty string`);
      }
      return;
    }
  }
}

/** Error carrying the offending key so the API can shape a 400 response. */
export class SettingValidationError extends Error {
  constructor(
    public readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = "SettingValidationError";
  }
}

/**
 * Resolve a field's effective value from the env default coerced to the field's type.
 * Mirrors env.ts: first present env key wins, otherwise the field default.
 */
function resolveFromEnv(field: SettingField, envSource: EnvSource): { value: unknown; source: SettingSource } {
  for (const envKey of field.envKeys) {
    const raw = envSource[envKey];
    if (raw !== undefined && raw.trim() !== "") {
      return { value: coerceEnv(field, raw), source: "env" };
    }
  }
  if (field.default !== undefined) {
    return { value: field.default, source: "default" };
  }
  // No env, no declared default — represent absence as empty for the field's kind.
  return { value: emptyForKind(field.kind), source: "default" };
}

function coerceEnv(field: SettingField, raw: string): unknown {
  switch (field.kind) {
    case "int": {
      const num = Number.parseInt(raw, 10);
      return Number.isFinite(num) ? num : (field.default ?? 0);
    }
    case "bool":
      return raw === "true" || raw === "1";
    case "csv":
      return raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    default:
      return raw.trim();
  }
}

function emptyForKind(kind: SettingKind): unknown {
  switch (kind) {
    case "int":
      return 0;
    case "bool":
      return false;
    case "csv":
      return [];
    default:
      return "";
  }
}

/**
 * Resolve every non-secret field to its effective `{ value, source }`. An override
 * present in `overrides` (and only for editable keys) wins over env, which wins over
 * the field default. Secret fields are omitted entirely so callers can serialize the
 * result for display without leaking secrets.
 */
export function resolveEffectiveSettings(
  envSource: EnvSource,
  overrides: Record<string, unknown>,
): Record<string, ResolvedSetting> {
  const result: Record<string, ResolvedSetting> = {};
  for (const field of SETTINGS_FIELDS) {
    if (isSecretField(field)) continue;
    const override = overrides[field.key];
    // Only editable fields honor an override; a stray override on a read-only key
    // is ignored so the registry stays the authority on what can change.
    if (field.editable && override !== undefined && isValidOverride(field, override)) {
      result[field.key] = { value: override, source: "override" };
      continue;
    }
    result[field.key] = resolveFromEnv(field, envSource);
  }
  return result;
}

/** Best-effort guard so a malformed persisted override falls back to env instead of throwing. */
function isValidOverride(field: SettingField, value: unknown): boolean {
  try {
    validateSettingValue(field, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a single editable field's effective value (override ⊕ env ⊕ default).
 * Used by the worker to read a live override per job / per sweep without rebuilding
 * the whole map. Returns the typed value.
 */
export function resolveEffectiveValue(
  field: SettingField,
  envSource: EnvSource,
  overrides: Record<string, unknown>,
): unknown {
  const override = overrides[field.key];
  if (field.editable && override !== undefined && isValidOverride(field, override)) {
    return override;
  }
  return resolveFromEnv(field, envSource).value;
}
