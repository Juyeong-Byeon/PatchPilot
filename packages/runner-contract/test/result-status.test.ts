import { describe, expect, it } from "vitest";
import { parseRunResultStatus } from "../src/result-status.js";

describe("parseRunResultStatus", () => {
  it("returns the status string for any envelope, including non-AgentResult statuses", () => {
    expect(parseRunResultStatus({ status: "needs_input" })).toBe("needs_input");
    expect(parseRunResultStatus({ status: "completed", changedFiles: ["a"], extra: 1 })).toBe("completed");
    expect(parseRunResultStatus({ status: "failed" })).toBe("failed");
  });

  it("returns undefined when status is missing, mis-typed, or the value is not an object", () => {
    expect(parseRunResultStatus({})).toBeUndefined();
    expect(parseRunResultStatus({ status: 5 })).toBeUndefined();
    expect(parseRunResultStatus(null)).toBeUndefined();
    expect(parseRunResultStatus("needs_input")).toBeUndefined();
  });
});
