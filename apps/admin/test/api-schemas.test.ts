import { describe, expect, it } from "vitest";
import {
  parseCancelResponse,
  parseJobMetrics,
  parseRecord,
  parseRecordArray,
  parseRetryResponse,
  parseSettingsView,
} from "../src/lib/api-schemas.js";

describe("parseJobMetrics", () => {
  it("accepts a full, well-typed payload", () => {
    const value = {
      totalJobs: 12,
      successRate: 0.83,
      mergeRate: 0.5,
      retryRate: 0.1,
      runtimeSeconds: { p50: 30, p95: 120, sampleSize: 9 },
      executorModeDistribution: { singlePass: 12, staged: 3, unknown: 0 },
    };
    expect(parseJobMetrics(value)).toBe(value);
  });

  it("accepts an empty object (every field optional, older backend)", () => {
    expect(parseJobMetrics({})).toEqual({});
  });

  it("accepts null inside runtimeSeconds percentiles", () => {
    const value = { runtimeSeconds: { p50: null, p95: null, sampleSize: 0 } };
    expect(parseJobMetrics(value)).toBe(value);
  });

  it("rejects a non-object body", () => {
    expect(parseJobMetrics(null)).toBeNull();
    expect(parseJobMetrics("nope")).toBeNull();
    expect(parseJobMetrics([1, 2, 3])).toBeNull();
  });

  it("rejects a present-but-wrong-typed scalar field", () => {
    expect(parseJobMetrics({ successRate: "fast" })).toBeNull();
    expect(parseJobMetrics({ totalJobs: Number.NaN })).toBeNull();
  });

  it("rejects a malformed runtimeSeconds shape", () => {
    expect(parseJobMetrics({ runtimeSeconds: "30s" })).toBeNull();
    expect(parseJobMetrics({ runtimeSeconds: { p50: "x" } })).toBeNull();
  });

  it("rejects an executorModeDistribution with a non-numeric count", () => {
    expect(parseJobMetrics({ executorModeDistribution: { staged: "3" } })).toBeNull();
    expect(parseJobMetrics({ executorModeDistribution: [1, 2] })).toBeNull();
  });
});

describe("parseSettingsView", () => {
  const field = {
    key: "MAX_ATTEMPTS",
    value: 3,
    editable: true,
    kind: "int",
    applies: "live",
    source: "override",
  };

  it("accepts a well-typed view", () => {
    const value = { sections: [{ key: "ops", fields: [field] }] };
    expect(parseSettingsView(value)).toBe(value);
  });

  it("accepts a view with no sections", () => {
    const value = { sections: [] };
    expect(parseSettingsView(value)).toBe(value);
  });

  it("rejects a body missing the sections array", () => {
    expect(parseSettingsView({})).toBeNull();
    expect(parseSettingsView({ sections: "x" })).toBeNull();
    expect(parseSettingsView(null)).toBeNull();
  });

  it("rejects a section whose fields is not an array", () => {
    expect(parseSettingsView({ sections: [{ key: "ops", fields: {} }] })).toBeNull();
  });

  it("rejects a field missing a required key", () => {
    const bad = { ...field, key: undefined };
    expect(parseSettingsView({ sections: [{ key: "ops", fields: [bad] }] })).toBeNull();
  });

  it("rejects a field with an unknown kind/applies/source enum value", () => {
    expect(parseSettingsView({ sections: [{ key: "ops", fields: [{ ...field, kind: "color" }] }] })).toBeNull();
    expect(parseSettingsView({ sections: [{ key: "ops", fields: [{ ...field, applies: "never" }] }] })).toBeNull();
    expect(parseSettingsView({ sections: [{ key: "ops", fields: [{ ...field, source: "guess" }] }] })).toBeNull();
  });

  it("rejects a field with a non-boolean editable", () => {
    expect(parseSettingsView({ sections: [{ key: "ops", fields: [{ ...field, editable: "yes" }] }] })).toBeNull();
  });
});

describe("parseRetryResponse", () => {
  it("accepts a well-typed response", () => {
    const value = { ok: true, runId: "run_1", attempt: 2 };
    expect(parseRetryResponse(value)).toBe(value);
  });

  it("rejects missing or wrong-typed fields", () => {
    expect(parseRetryResponse(null)).toBeNull();
    expect(parseRetryResponse({ ok: true, runId: "run_1" })).toBeNull();
    expect(parseRetryResponse({ ok: "yes", runId: "run_1", attempt: 2 })).toBeNull();
    expect(parseRetryResponse({ ok: true, runId: 1, attempt: 2 })).toBeNull();
    expect(parseRetryResponse({ ok: true, runId: "run_1", attempt: "2" })).toBeNull();
  });
});

describe("parseCancelResponse", () => {
  it("accepts a well-typed ack", () => {
    const value = { ok: true, phase: "Cancelled" };
    expect(parseCancelResponse(value)).toBe(value);
  });

  it("rejects missing or wrong-typed fields", () => {
    expect(parseCancelResponse({ ok: true })).toBeNull();
    expect(parseCancelResponse({ ok: true, phase: 7 })).toBeNull();
    expect(parseCancelResponse("Cancelled")).toBeNull();
  });
});

describe("parseRecordArray / parseRecord", () => {
  it("accepts an array of objects", () => {
    const value = [{ id: "a" }, { id: "b" }];
    expect(parseRecordArray(value)).toBe(value);
  });

  it("rejects a non-array or an array containing a scalar", () => {
    expect(parseRecordArray({ id: "a" })).toBeNull();
    expect(parseRecordArray([{ id: "a" }, "b"])).toBeNull();
    expect(parseRecordArray([null])).toBeNull();
  });

  it("accepts a single object and rejects arrays/scalars", () => {
    const value = { id: "a" };
    expect(parseRecord(value)).toBe(value);
    expect(parseRecord([{ id: "a" }])).toBeNull();
    expect(parseRecord("a")).toBeNull();
    expect(parseRecord(null)).toBeNull();
  });
});
