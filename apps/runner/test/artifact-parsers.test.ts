import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readNeedsInput, readStructuredFailure } from "../src/codex-agent-runner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeOutputDir(): Promise<string> {
  const outputDir = await mkdtemp(join(tmpdir(), "ticket-to-pr-artifact-"));
  tempDirs.push(outputDir);
  return outputDir;
}

async function writeArtifact(outputDir: string, file: string, contents: string): Promise<void> {
  await writeFile(join(outputDir, file), contents);
}

describe("readStructuredFailure", () => {
  it("returns null when failure.json is absent", async () => {
    const outputDir = await makeOutputDir();
    expect(await readStructuredFailure(outputDir)).toBeNull();
  });

  it("returns null when failure.json is empty or whitespace-only", async () => {
    const outputDir = await makeOutputDir();
    await writeArtifact(outputDir, "failure.json", "   \n  ");
    expect(await readStructuredFailure(outputDir)).toBeNull();
  });

  it("returns null when failure.json is not valid JSON", async () => {
    const outputDir = await makeOutputDir();
    await writeArtifact(outputDir, "failure.json", "{ not: valid json ");
    expect(await readStructuredFailure(outputDir)).toBeNull();
  });

  it("returns null when a required field is missing", async () => {
    const outputDir = await makeOutputDir();
    // `nextAction` omitted.
    await writeArtifact(
      outputDir,
      "failure.json",
      JSON.stringify({ stage: "implement", category: "agent", message: "blocked" }),
    );
    expect(await readStructuredFailure(outputDir)).toBeNull();
  });

  it("returns null when a required field is present but blank after trimming", async () => {
    const outputDir = await makeOutputDir();
    await writeArtifact(
      outputDir,
      "failure.json",
      JSON.stringify({ stage: "implement", category: "agent", message: "blocked", nextAction: "   " }),
    );
    expect(await readStructuredFailure(outputDir)).toBeNull();
  });

  it("returns null when a required field is the wrong type", async () => {
    const outputDir = await makeOutputDir();
    await writeArtifact(
      outputDir,
      "failure.json",
      JSON.stringify({ stage: "implement", category: 42, message: "blocked", nextAction: "clarify" }),
    );
    expect(await readStructuredFailure(outputDir)).toBeNull();
  });

  it("returns the trimmed failure when all required fields are present", async () => {
    const outputDir = await makeOutputDir();
    await writeArtifact(
      outputDir,
      "failure.json",
      JSON.stringify({
        stage: "  implement  ",
        category: " agent ",
        message: " Ticket is contradictory. ",
        nextAction: " Clarify the Definition of Done. ",
      }),
    );
    expect(await readStructuredFailure(outputDir)).toEqual({
      stage: "implement",
      category: "agent",
      message: "Ticket is contradictory.",
      nextAction: "Clarify the Definition of Done.",
      retryable: undefined,
    });
  });

  it("keeps a present boolean `retryable`", async () => {
    const outputDir = await makeOutputDir();
    await writeArtifact(
      outputDir,
      "failure.json",
      JSON.stringify({
        stage: "setup",
        category: "infra",
        message: "Registry unreachable.",
        nextAction: "Retry later.",
        retryable: true,
      }),
    );
    expect(await readStructuredFailure(outputDir)).toEqual({
      stage: "setup",
      category: "infra",
      message: "Registry unreachable.",
      nextAction: "Retry later.",
      retryable: true,
    });
  });

  it("drops a non-boolean `retryable` to undefined", async () => {
    const outputDir = await makeOutputDir();
    await writeArtifact(
      outputDir,
      "failure.json",
      JSON.stringify({
        stage: "setup",
        category: "infra",
        message: "Registry unreachable.",
        nextAction: "Retry later.",
        retryable: "yes",
      }),
    );
    const result = await readStructuredFailure(outputDir);
    expect(result).not.toBeNull();
    expect(result?.retryable).toBeUndefined();
  });
});

describe("readNeedsInput", () => {
  it("returns null when needs-input.json is absent", async () => {
    const outputDir = await makeOutputDir();
    expect(await readNeedsInput(outputDir)).toBeNull();
  });

  it("returns null when needs-input.json is empty or whitespace-only", async () => {
    const outputDir = await makeOutputDir();
    await writeArtifact(outputDir, "needs-input.json", "   \n");
    expect(await readNeedsInput(outputDir)).toBeNull();
  });

  it("returns null when needs-input.json is not valid JSON", async () => {
    const outputDir = await makeOutputDir();
    await writeArtifact(outputDir, "needs-input.json", "{ question: ");
    expect(await readNeedsInput(outputDir)).toBeNull();
  });

  it("returns null when the question is missing", async () => {
    const outputDir = await makeOutputDir();
    await writeArtifact(outputDir, "needs-input.json", JSON.stringify({ details: "some context" }));
    expect(await readNeedsInput(outputDir)).toBeNull();
  });

  it("returns null when the question is whitespace-only", async () => {
    const outputDir = await makeOutputDir();
    await writeArtifact(outputDir, "needs-input.json", JSON.stringify({ question: "   " }));
    expect(await readNeedsInput(outputDir)).toBeNull();
  });

  it("returns null when the question is the wrong type", async () => {
    const outputDir = await makeOutputDir();
    await writeArtifact(outputDir, "needs-input.json", JSON.stringify({ question: 7 }));
    expect(await readNeedsInput(outputDir)).toBeNull();
  });

  it("returns the trimmed question only when no details are present", async () => {
    const outputDir = await makeOutputDir();
    await writeArtifact(
      outputDir,
      "needs-input.json",
      JSON.stringify({ question: "  Should the export be CSV or XLSX?  " }),
    );
    expect(await readNeedsInput(outputDir)).toEqual({ question: "Should the export be CSV or XLSX?" });
  });

  it("returns the trimmed question and details when details are non-empty", async () => {
    const outputDir = await makeOutputDir();
    await writeArtifact(
      outputDir,
      "needs-input.json",
      JSON.stringify({
        question: "  Should the export be CSV or XLSX?  ",
        details: "  The ticket says spreadsheet without a format.  ",
      }),
    );
    expect(await readNeedsInput(outputDir)).toEqual({
      question: "Should the export be CSV or XLSX?",
      details: "The ticket says spreadsheet without a format.",
    });
  });

  it("drops whitespace-only details, keeping only the question", async () => {
    const outputDir = await makeOutputDir();
    await writeArtifact(
      outputDir,
      "needs-input.json",
      JSON.stringify({ question: "Which environment?", details: "   " }),
    );
    expect(await readNeedsInput(outputDir)).toEqual({ question: "Which environment?" });
  });
});
