import { describe, expect, it } from "vitest";
import { deriveOutcome, transitionPhase } from "../src/state.js";

describe("transitionPhase", () => {
  it("allows queued to planning", () => {
    expect(transitionPhase("Queued", "Planning")).toBe("Planning");
  });

  it("blocks publishing before policy checking", () => {
    expect(() => transitionPhase("Testing", "Publishing")).toThrow(/Invalid phase transition/);
  });

  it("allows a running phase to park on AwaitingInput", () => {
    expect(transitionPhase("Implementing", "AwaitingInput")).toBe("AwaitingInput");
    expect(transitionPhase("Planning", "AwaitingInput")).toBe("AwaitingInput");
    expect(transitionPhase("Reviewing", "AwaitingInput")).toBe("AwaitingInput");
    expect(transitionPhase("Testing", "AwaitingInput")).toBe("AwaitingInput");
  });

  it("resumes AwaitingInput back to Queued (answer re-queues a fresh attempt)", () => {
    expect(transitionPhase("AwaitingInput", "Queued")).toBe("Queued");
  });

  it("does not let AwaitingInput jump straight back into a running phase or publish", () => {
    expect(() => transitionPhase("AwaitingInput", "Implementing")).toThrow(/Invalid phase transition/);
    expect(() => transitionPhase("AwaitingInput", "Publishing")).toThrow(/Invalid phase transition/);
  });
});

describe("deriveOutcome", () => {
  it("maps active phase to Running", () => {
    expect(deriveOutcome("Testing")).toBe("Running");
  });

  it("maps completed phase to NeedsReview", () => {
    expect(deriveOutcome("Completed")).toBe("NeedsReview");
  });

  it("maps AwaitingInput phase to NeedsInput", () => {
    expect(deriveOutcome("AwaitingInput")).toBe("NeedsInput");
  });
});
