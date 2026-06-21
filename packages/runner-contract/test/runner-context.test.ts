import { describe, expect, it } from "vitest";
import { parseRunnerContext } from "../src/runner-context.js";

const validContext = {
  jobId: "job-1",
  ticketSnapshotId: "snap-1",
  triggerVersion: "v1",
  runId: "run-1",
  attempt: 0,
  workBranch: "ticket/job-1-attempt-1",
};

describe("parseRunnerContext", () => {
  it("parses a valid context from a JSON string", () => {
    const context = parseRunnerContext(JSON.stringify(validContext));
    expect(context).toMatchObject(validContext);
  });

  it("parses a valid already-parsed object", () => {
    const context = parseRunnerContext(validContext);
    expect(context.runId).toBe("run-1");
  });

  it("passes through producer-only extra fields without rejecting", () => {
    const context = parseRunnerContext({
      ...validContext,
      larkRecordId: "rec-1",
      retryGuidance: "try harder",
    });
    expect(context).toMatchObject({ larkRecordId: "rec-1", retryGuidance: "try harder" });
  });

  it("throws when a required field is missing (producer/consumer drift)", () => {
    const { triggerVersion: _omitted, ...missingField } = validContext;
    expect(() => parseRunnerContext(JSON.stringify(missingField))).toThrow(/context\.json failed validation/);
  });

  it("throws when a required field has the wrong type", () => {
    expect(() => parseRunnerContext({ ...validContext, attempt: "not-a-number" })).toThrow(
      /context\.json failed validation/,
    );
  });

  it("throws when a required string field is empty", () => {
    expect(() => parseRunnerContext({ ...validContext, runId: "" })).toThrow(/context\.json failed validation/);
  });

  it("throws on invalid JSON input", () => {
    expect(() => parseRunnerContext("{ not json")).toThrow(/context\.json is not valid JSON/);
  });
});
