import { describe, expect, it } from "vitest";
import { createArtifactId, createJobId, createPrefixedId, createRunId, createTicketSnapshotId } from "../src/ids.js";

function expectPrefixedId(id: string, prefix: string): void {
  const expectedPrefix = `${prefix}_`;

  expect(id.startsWith(expectedPrefix)).toBe(true);
  expect(id.slice(expectedPrefix.length).length).toBeGreaterThan(0);
}

describe("id helpers", () => {
  it("creates generated ids with stable prefixes", () => {
    expectPrefixedId(createPrefixedId("custom"), "custom");
    expectPrefixedId(createJobId(), "job");
    expectPrefixedId(createTicketSnapshotId(), "ts");
    expectPrefixedId(createRunId(), "run");
    expectPrefixedId(createArtifactId(), "artifact");
  });
});
