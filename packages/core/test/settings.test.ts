import { describe, expect, it } from "vitest";
import {
  EDITABLE_KEYS,
  SETTINGS_FIELDS,
  SettingValidationError,
  getSettingField,
  parseSettingValue,
  resolveEffectiveSettings,
  resolveEffectiveValue,
  validateSettingValue,
  type SettingField,
} from "../src/settings.js";

function field(key: string): SettingField {
  const f = getSettingField(key);
  if (!f) throw new Error(`missing field ${key}`);
  return f;
}

describe("settings registry", () => {
  it("marks exactly the intended fields editable", () => {
    expect([...EDITABLE_KEYS].sort()).toEqual(
      [
        "failedWorkspaceRetentionDays",
        "jobTimeoutSeconds",
        "reconcileIntervalMs",
        "runHeartbeatIntervalMs",
        "workspaceSweepIntervalMs",
      ].sort(),
    );
  });

  it("keeps security fields read-only", () => {
    expect(field("repositoryAllowlist").editable).toBe(false);
    expect(field("protectedPathDenylist").editable).toBe(false);
  });

  it("classifies live vs restart applies", () => {
    expect(field("jobTimeoutSeconds").applies).toBe("live");
    expect(field("failedWorkspaceRetentionDays").applies).toBe("live");
    expect(field("reconcileIntervalMs").applies).toBe("restart");
    expect(field("runHeartbeatIntervalMs").applies).toBe("restart");
    expect(field("workspaceSweepIntervalMs").applies).toBe("restart");
  });
});

describe("parseSettingValue", () => {
  it("parses ints from string and number", () => {
    expect(parseSettingValue(field("jobTimeoutSeconds"), "120")).toBe(120);
    expect(parseSettingValue(field("jobTimeoutSeconds"), 3600)).toBe(3600);
  });

  it("rejects non-integers", () => {
    expect(() => parseSettingValue(field("jobTimeoutSeconds"), "abc")).toThrow(SettingValidationError);
    expect(() => parseSettingValue(field("jobTimeoutSeconds"), 1.5)).toThrow(SettingValidationError);
  });

  it("parses bools from string and boolean", () => {
    expect(parseSettingValue({ ...field("jobTimeoutSeconds"), key: "flag", kind: "bool" }, "true")).toBe(true);
    expect(parseSettingValue({ ...field("jobTimeoutSeconds"), key: "flag", kind: "bool" }, false)).toBe(false);
    expect(() => parseSettingValue({ ...field("jobTimeoutSeconds"), key: "flag", kind: "bool" }, "maybe")).toThrow(
      SettingValidationError,
    );
  });

  it("parses csv from string and array", () => {
    expect(parseSettingValue(field("repositoryAllowlist"), "a/b, c/d,")).toEqual(["a/b", "c/d"]);
    expect(parseSettingValue(field("repositoryAllowlist"), ["x", " y "])).toEqual(["x", "y"]);
  });
});

describe("validateSettingValue", () => {
  it("enforces the int range", () => {
    expect(() => validateSettingValue(field("jobTimeoutSeconds"), 59)).toThrow(/>= 60/);
    expect(() => validateSettingValue(field("jobTimeoutSeconds"), 86401)).toThrow(/<= 86400/);
    expect(() => validateSettingValue(field("jobTimeoutSeconds"), 3600)).not.toThrow();
  });

  it("enforces enum membership", () => {
    expect(() => validateSettingValue(field("executorMode"), "gstack")).not.toThrow();
    expect(() => validateSettingValue(field("executorMode"), "nope")).toThrow(SettingValidationError);
  });

  it("rejects an empty string", () => {
    expect(() => validateSettingValue(field("runnerImage"), "")).toThrow(SettingValidationError);
  });
});

describe("resolveEffectiveSettings", () => {
  it("prefers override > env > default for editable fields", () => {
    const resolved = resolveEffectiveSettings({ WORKER_JOB_TIMEOUT_SECONDS: "1800" }, { jobTimeoutSeconds: 999 });
    expect(resolved.jobTimeoutSeconds).toEqual({ value: 999, source: "override" });

    const envOnly = resolveEffectiveSettings({ WORKER_JOB_TIMEOUT_SECONDS: "1800" }, {});
    expect(envOnly.jobTimeoutSeconds).toEqual({ value: 1800, source: "env" });

    const noConfig = resolveEffectiveSettings({}, {});
    expect(noConfig.jobTimeoutSeconds).toEqual({ value: 3600, source: "default" });
  });

  it("ignores an override on a read-only key (security cannot be widened)", () => {
    const resolved = resolveEffectiveSettings(
      { REPOSITORY_ALLOWLIST: "acme/web" },
      { repositoryAllowlist: ["evil/repo"] },
    );
    expect(resolved.repositoryAllowlist).toEqual({ value: ["acme/web"], source: "env" });
  });

  it("falls back to env when a persisted override is invalid", () => {
    const resolved = resolveEffectiveSettings(
      { WORKER_JOB_TIMEOUT_SECONDS: "1800" },
      { jobTimeoutSeconds: 5 /* below min */ },
    );
    expect(resolved.jobTimeoutSeconds).toEqual({ value: 1800, source: "env" });
  });

  it("omits secret fields entirely", () => {
    // No secret fields are declared today, but the resolver must never emit one.
    const secretFields = SETTINGS_FIELDS.filter((f) => f.secret === true);
    const resolved = resolveEffectiveSettings({}, {});
    for (const f of secretFields) {
      expect(resolved[f.key]).toBeUndefined();
    }
  });

  it("resolveEffectiveValue mirrors override > env for a single field", () => {
    expect(resolveEffectiveValue(field("jobTimeoutSeconds"), { WORKER_JOB_TIMEOUT_SECONDS: "1800" }, {})).toBe(1800);
    expect(resolveEffectiveValue(field("jobTimeoutSeconds"), {}, { jobTimeoutSeconds: 600 })).toBe(600);
    expect(resolveEffectiveValue(field("jobTimeoutSeconds"), {}, {})).toBe(3600);
  });
});
