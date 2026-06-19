import { randomUUID } from "node:crypto";

export function createPrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function createJobId(): string {
  return createPrefixedId("job");
}

export function createTicketSnapshotId(): string {
  return createPrefixedId("ts");
}

export function createRunId(): string {
  return createPrefixedId("run");
}

export function createArtifactId(): string {
  return createPrefixedId("artifact");
}
