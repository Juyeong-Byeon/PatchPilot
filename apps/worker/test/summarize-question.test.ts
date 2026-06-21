import { describe, expect, it } from "vitest";
import { summarizeQuestion } from "../src/worker.js";

const MAX = 280;

describe("summarizeQuestion", () => {
  it("passes a short question through unchanged", () => {
    const question = "Why did the run fail?";
    expect(summarizeQuestion(question)).toBe(question);
  });

  it("trims leading/trailing whitespace before the length check", () => {
    expect(summarizeQuestion("   spaced out   ")).toBe("spaced out");
  });

  it("does not truncate a question exactly at the max length", () => {
    const question = "a".repeat(MAX);
    const result = summarizeQuestion(question);
    expect(result).toBe(question);
    expect(result.length).toBe(MAX);
    expect(result.endsWith("…")).toBe(false);
  });

  it("does not truncate after trimming to the max length", () => {
    const question = `  ${"a".repeat(MAX)}  `;
    const result = summarizeQuestion(question);
    expect(result).toBe("a".repeat(MAX));
    expect(result.length).toBe(MAX);
    expect(result.endsWith("…")).toBe(false);
  });

  it("truncates a question over the max to slice + ellipsis", () => {
    const question = "a".repeat(MAX + 50);
    const result = summarizeQuestion(question);
    // slice(0, MAX - 1) keeps 279 chars, then the "…" ellipsis is appended.
    expect(result.length).toBe(MAX);
    expect(result.endsWith("…")).toBe(true);
    expect(result).toBe(`${"a".repeat(MAX - 1)}…`);
  });

  it("trims before measuring, so trailing whitespace does not trigger truncation", () => {
    const question = `${"a".repeat(MAX)}${" ".repeat(50)}`;
    const result = summarizeQuestion(question);
    expect(result).toBe("a".repeat(MAX));
    expect(result.endsWith("…")).toBe(false);
  });
});
