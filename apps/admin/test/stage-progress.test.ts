import { describe, expect, it } from "vitest";
import {
  deriveStageStates,
  isCancellingPhase,
  isNeedsInputJob,
  isStageBannerText,
  matchesStatusFilter,
  resolvePrimaryStatus,
  statusBadgeVariant,
  type StageStatus,
} from "../src/lib/status.js";

describe("NeedsInput (입력 대기) status", () => {
  it("recognizes a parked job from either the outcome or the phase", () => {
    expect(isNeedsInputJob("AwaitingInput", "NeedsInput")).toBe(true);
    expect(isNeedsInputJob("Implementing", "NeedsInput")).toBe(true);
    expect(isNeedsInputJob("AwaitingInput", "Running")).toBe(true);
    expect(isNeedsInputJob("Implementing", "Running")).toBe(false);
    expect(isNeedsInputJob("Completed", "NeedsReview")).toBe(false);
  });

  it("resolves the primary status to NeedsInput", () => {
    expect(resolvePrimaryStatus({ phase: "AwaitingInput", outcome: "NeedsInput" })).toBe("NeedsInput");
  });

  it("maps NeedsInput to the distinct info variant (not amber warning, not danger)", () => {
    expect(statusBadgeVariant("NeedsInput")).toBe("info");
    expect(statusBadgeVariant("AwaitingInput")).toBe("info");
    // It is deliberately different from NeedsReview (amber) and from a failure (danger).
    expect(statusBadgeVariant("NeedsReview")).toBe("warning");
    expect(statusBadgeVariant("FailedInternal")).toBe("danger");
  });

  it("matches the needsInput filter and is mutually exclusive with the others", () => {
    const parked = { phase: "AwaitingInput", outcome: "NeedsInput" };
    expect(matchesStatusFilter(parked, "needsInput")).toBe(true);
    expect(matchesStatusFilter(parked, "running")).toBe(false);
    expect(matchesStatusFilter(parked, "needsReview")).toBe(false);
    expect(matchesStatusFilter(parked, "failed")).toBe(false);
    expect(matchesStatusFilter(parked, "completed")).toBe(false);
    // A normal running job does not match the needsInput chip.
    expect(matchesStatusFilter({ phase: "Implementing", outcome: "Running" }, "needsInput")).toBe(false);
  });
});

describe("isCancellingPhase", () => {
  it("flags only the in-flight cancel phases (outcome still reads Running)", () => {
    expect(isCancellingPhase("CancelRequested")).toBe(true);
    expect(isCancellingPhase("Cancelling")).toBe(true);
    // Terminal cancel states already carry a settled outcome, so they are not in-flight.
    expect(isCancellingPhase("Cancelled")).toBe(false);
    expect(isCancellingPhase("CancelFailed")).toBe(false);
    expect(isCancellingPhase("Implementing")).toBe(false);
  });
});

describe("isStageBannerText", () => {
  it("detects gstack stage banners", () => {
    expect(isStageBannerText("=== gstack stage 2/4: implement ===")).toBe(true);
    expect(isStageBannerText("normal log line")).toBe(false);
    expect(isStageBannerText(undefined)).toBe(false);
  });
});

interface TestEvent {
  event_type?: string;
  phase?: string;
  metadata?: unknown;
  created_at?: string;
}

function stageEvent(index: number, key: string, createdAt: string): TestEvent {
  return {
    event_type: "gstack.stage",
    phase: "Implementing",
    metadata: { stageIndex: index, stageTotal: 5, stageKey: key },
    created_at: createdAt,
  };
}

const T = (n: number) => `2026-06-20T00:0${n}:00.000Z`;

describe("deriveStageStates", () => {
  it("returns null when the run emitted no stage events (non-staged run)", () => {
    expect(
      deriveStageStates([{ event_type: "runner.started", phase: "Implementing" }], "Implementing", "Running"),
    ).toBeNull();
    expect(deriveStageStates([], "Implementing", "Running")).toBeNull();
  });

  it("marks earlier stages complete and the latest started stage active mid-run", () => {
    const states = deriveStageStates(
      [stageEvent(1, "plan", T(0)), stageEvent(2, "implement", T(1)), stageEvent(3, "review", T(2))],
      "Implementing",
      "Running",
    );
    expect(states?.map((s) => s.status)).toEqual<StageStatus[]>([
      "complete",
      "complete",
      "active",
      "pending",
      "pending",
    ]);
    expect(states?.map((s) => s.key)).toEqual(["plan", "implement", "review", "verify", "document"]);
  });

  it("computes each completed stage's elapsed window from the next stage's start", () => {
    const states = deriveStageStates(
      [stageEvent(1, "plan", T(0)), stageEvent(2, "implement", T(1))],
      "Implementing",
      "Running",
    );
    const plan = states?.[0];
    expect(plan?.status).toBe("complete");
    expect(plan?.startMs).toBe(Date.parse(T(0)));
    expect(plan?.endMs).toBe(Date.parse(T(1)));
  });

  it("marks every stage complete once the run moved past implementing", () => {
    const states = deriveStageStates(
      [
        stageEvent(1, "plan", T(0)),
        stageEvent(2, "implement", T(1)),
        stageEvent(3, "review", T(2)),
        stageEvent(4, "verify", T(3)),
      ],
      "Completed",
      "NeedsReview",
    );
    expect(states?.every((s) => s.status === "complete")).toBe(true);
  });

  it("does not paint stages failed when the run failed AFTER implementing (e.g. policy gate)", () => {
    const states = deriveStageStates(
      [
        stageEvent(1, "plan", T(0)),
        stageEvent(2, "implement", T(1)),
        stageEvent(3, "review", T(2)),
        stageEvent(4, "verify", T(3)),
        { event_type: "policy.blocked", phase: "PolicyChecking", created_at: T(4) },
      ],
      "Failed",
      "FailedActionable",
    );
    expect(states?.every((s) => s.status === "complete")).toBe(true);
  });

  it("marks the active stage failed when the run failed during implementing", () => {
    const states = deriveStageStates(
      [stageEvent(1, "plan", T(0)), stageEvent(2, "implement", T(1))],
      "Failed",
      "FailedInternal",
    );
    expect(states?.map((s) => s.status)).toEqual<StageStatus[]>([
      "complete",
      "failed",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("marks the active stage failed when the run was cancelled mid-implementing", () => {
    const states = deriveStageStates(
      [stageEvent(1, "plan", T(0)), stageEvent(2, "implement", T(1))],
      "Cancelled",
      "Cancelled",
    );
    expect(states?.[1]?.status).toBe("failed");
  });

  it("keeps the active stage spinning during a transient cancel-requested state", () => {
    const states = deriveStageStates(
      [stageEvent(1, "plan", T(0)), stageEvent(2, "implement", T(1))],
      "CancelRequested",
      "Running",
    );
    expect(states?.[1]?.status).toBe("active");
  });

  it("dedupes repeated banners for the same stage, keeping the earliest timestamp", () => {
    const states = deriveStageStates(
      [stageEvent(1, "plan", T(2)), stageEvent(1, "plan", T(0)), stageEvent(2, "implement", T(3))],
      "Implementing",
      "Running",
    );
    expect(states?.[0]?.startMs).toBe(Date.parse(T(0)));
  });
});
