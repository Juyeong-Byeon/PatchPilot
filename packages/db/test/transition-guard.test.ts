import { transitionPhase, type InternalPhase } from "@ticket-to-pr/core";
import { describe, expect, it } from "vitest";
import { ALL_PHASES, isTerminalPhase, phasesAllowedToTransitionTo, TERMINAL_PHASES } from "../src/transition-guard.js";

describe("transition-guard / phasesAllowedToTransitionTo", () => {
  it("derives the cancel guard's allowed-from set straight from core's whitelist", () => {
    // This is the exact `from` set that requestCancel feeds into
    // `where phase = any($expectedFrom)`. Publishing and every terminal/cancel
    // phase must be absent.
    expect([...phasesAllowedToTransitionTo("CancelRequested")].sort()).toEqual(
      ["AwaitingInput", "Implementing", "Planning", "Queued", "Reviewing", "Testing"].sort(),
    );
  });

  it("only allows Publishing -> Completed (terminal completion has one entry phase)", () => {
    expect(phasesAllowedToTransitionTo("Completed")).toEqual(["Publishing"]);
  });

  it("allows Cancelled only from Cancelling", () => {
    expect(phasesAllowedToTransitionTo("Cancelled")).toEqual(["Cancelling"]);
  });

  it("never includes a self-transition", () => {
    for (const phase of ALL_PHASES) {
      expect(phasesAllowedToTransitionTo(phase)).not.toContain(phase);
    }
  });

  it("agrees with core transitionPhase for every (from,next) pair", () => {
    // The DB guard predicate must accept exactly the transitions core accepts.
    for (const next of ALL_PHASES) {
      const allowedFrom = new Set(phasesAllowedToTransitionTo(next));
      for (const from of ALL_PHASES) {
        if (from === next) continue;
        let coreAllows = false;
        try {
          transitionPhase(from, next);
          coreAllows = true;
        } catch {
          coreAllows = false;
        }
        expect(allowedFrom.has(from)).toBe(coreAllows);
      }
    }
  });
});

describe("transition-guard / terminal invariant", () => {
  it("treats Completed, Failed and Cancelled as terminal", () => {
    expect([...TERMINAL_PHASES].sort()).toEqual(["Cancelled", "Completed", "Failed"].sort());
  });

  it("does NOT treat CancelFailed as terminal (core still allows CancelFailed -> Failed)", () => {
    expect(isTerminalPhase("CancelFailed")).toBe(false);
    expect(() => transitionPhase("CancelFailed", "Failed")).not.toThrow();
  });

  it("a terminal phase has no outgoing transition in core", () => {
    const terminal: InternalPhase[] = ["Completed", "Failed", "Cancelled"];
    for (const phase of terminal) {
      expect(isTerminalPhase(phase)).toBe(true);
      for (const next of ALL_PHASES) {
        expect(() => transitionPhase(phase, next)).toThrow(/Invalid phase transition/);
      }
    }
  });

  it("enumerates every InternalPhase exactly once", () => {
    expect(new Set(ALL_PHASES).size).toBe(ALL_PHASES.length);
    expect(ALL_PHASES.length).toBe(14);
  });
});
