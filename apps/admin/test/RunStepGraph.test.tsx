// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunStepGraph } from "../src/components/RunStepGraph.js";
import { adminCopy } from "../src/i18n.js";

describe("RunStepGraph", () => {
  afterEach(() => cleanup());

  it("renders a GitHub Actions style phase graph with failure state", () => {
    render(
      <RunStepGraph
        copy={adminCopy.ko}
        locale="ko"
        currentPhase="Failed"
        events={[
          {
            id: "1",
            phase: "Queued",
            event_type: "job.enqueued",
            source: "api",
            message: "accepted",
            created_at: "2026-06-20T00:00:00.000Z",
          },
          {
            id: "2",
            phase: "Implementing",
            event_type: "worker.started",
            source: "worker",
            message: "clone started",
            created_at: "2026-06-20T00:00:05.000Z",
          },
          {
            id: "3",
            phase: "Implementing",
            event_type: "worker.failed",
            source: "worker",
            message: "git authentication failed",
            created_at: "2026-06-20T00:00:12.000Z",
          },
        ]}
      />,
    );

    const graph = screen.getByRole("list", { name: "처리 단계 그래프" });

    expect(within(graph).getAllByRole("button")).toHaveLength(6);
    expect(within(graph).getAllByText("대기").length).toBeGreaterThan(0);
    expect(within(graph).getByText("건너뜀")).toBeInTheDocument();
    expect(within(graph).getByText("구현")).toBeInTheDocument();
    expect(within(graph).getByRole("button", { name: "구현 실패 지점" })).toBeInTheDocument();
    expect(within(graph).getByText("실패 지점")).toBeInTheDocument();
    expect(within(graph).queryByText(/2 이벤트/)).not.toBeInTheDocument();
    expect(within(graph).queryByText("worker")).not.toBeInTheDocument();
    expect(within(graph).queryByText("git authentication failed")).not.toBeInTheDocument();
  });

  it("animates the currently running phase", () => {
    const { container } = render(
      <RunStepGraph
        copy={adminCopy.ko}
        locale="ko"
        currentPhase="Implementing"
        events={[
          {
            id: "1",
            phase: "Queued",
            event_type: "job.enqueued",
            source: "api",
            message: "accepted",
            created_at: "2026-06-20T00:00:00.000Z",
          },
          {
            id: "2",
            phase: "Implementing",
            event_type: "worker.started",
            source: "worker",
            message: "clone started",
            created_at: "2026-06-20T00:00:05.000Z",
          },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "구현 진행 중" })).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("renders a distinct 'awaiting input' gate after Implementing when parked", () => {
    const { container } = render(
      <RunStepGraph
        copy={adminCopy.ko}
        locale="ko"
        currentPhase="AwaitingInput"
        events={[
          {
            id: "1",
            phase: "Queued",
            event_type: "job.enqueued",
            source: "api",
            message: "accepted",
            created_at: "2026-06-20T00:00:00.000Z",
          },
          {
            id: "2",
            phase: "Implementing",
            event_type: "runner.started",
            source: "gstack",
            message: "runner started",
            created_at: "2026-06-20T00:00:05.000Z",
          },
          {
            id: "3",
            phase: "AwaitingInput",
            event_type: "job.needs_input",
            source: "worker",
            message: "어떤 DB를 쓸까요?",
            created_at: "2026-06-20T00:00:12.000Z",
          },
        ]}
      />,
    );

    const graph = screen.getByRole("list", { name: "처리 단계 그래프" });
    // The gate has its own label — not the generic running spinner.
    expect(within(graph).getByRole("button", { name: "입력 대기 입력 대기 중" })).toBeInTheDocument();
    // It sits right after Implementing and before PolicyChecking.
    const labels = within(graph)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? "");
    const implementing = labels.findIndex((label) => label.startsWith("구현"));
    const awaiting = labels.findIndex((label) => label.startsWith("입력 대기"));
    const policy = labels.findIndex((label) => label.startsWith("정책"));
    expect(implementing).toBeLessThan(awaiting);
    expect(awaiting).toBeLessThan(policy);
    // Distinct violet pulse for "needs your action", never the blue running spinner.
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
  });

  it("attributes terminal failure to the last running phase", () => {
    const { container } = render(
      <RunStepGraph
        copy={adminCopy.ko}
        locale="ko"
        currentPhase="Failed"
        events={[
          {
            id: "1",
            phase: "Queued",
            event_type: "job.enqueued",
            source: "api",
            message: "accepted",
            created_at: "2026-06-20T00:00:00.000Z",
          },
          {
            id: "2",
            phase: "Implementing",
            event_type: "worker.started",
            source: "worker",
            message: "runner started",
            created_at: "2026-06-20T00:00:05.000Z",
          },
          {
            id: "3",
            phase: "Failed",
            event_type: "worker.error",
            source: "worker",
            message: "gstack runner exited with code 1",
            created_at: "2026-06-20T00:00:12.000Z",
          },
        ]}
      />,
    );

    const graph = screen.getByRole("list", { name: "처리 단계 그래프" });
    const implementingButton = within(graph).getByRole("button", { name: "구현 실패 지점" });

    expect(implementingButton).toBeInTheDocument();
    expect(within(graph).queryByRole("button", { name: "실패 실패 지점" })).not.toBeInTheDocument();
    expect(container.querySelector(".bg-danger")).toBeInTheDocument();
  });

  it("does not draw a failed connector after the failed phase", () => {
    const { container } = render(
      <RunStepGraph
        copy={adminCopy.ko}
        locale="ko"
        currentPhase="Failed"
        events={[
          {
            id: "1",
            phase: "Queued",
            event_type: "job.enqueued",
            source: "api",
            message: "accepted",
            created_at: "2026-06-20T00:00:00.000Z",
          },
          {
            id: "2",
            phase: "Planning",
            event_type: "worker.started",
            source: "worker",
            message: "runner started",
            created_at: "2026-06-20T00:00:01.000Z",
          },
          {
            id: "3",
            phase: "Planning",
            event_type: "worker.error",
            source: "worker",
            message: "gstack runner exited with code 125",
            created_at: "2026-06-20T00:00:02.000Z",
          },
        ]}
      />,
    );

    const graph = screen.getByRole("list", { name: "처리 단계 그래프" });

    expect(within(graph).getByRole("button", { name: "계획 실패 지점" })).toBeInTheDocument();
    expect(container.querySelector('[data-connector-from="Planning"]')).toHaveClass("bg-hairline-gray");
    expect(container.querySelector('[data-connector-from="Planning"]')).not.toHaveClass("bg-danger");
  });

  it("reserves vertical room for selected and failed graph states", () => {
    const { container } = render(
      <RunStepGraph
        copy={adminCopy.ko}
        locale="ko"
        currentPhase="Failed"
        selectedStep={{ phase: "Planning" }}
        events={[
          {
            id: "1",
            phase: "Queued",
            event_type: "job.enqueued",
            source: "api",
            message: "accepted",
            created_at: "2026-06-20T00:00:00.000Z",
          },
          {
            id: "2",
            phase: "Planning",
            event_type: "worker.error",
            source: "worker",
            message: "gstack runner exited with code 125",
            created_at: "2026-06-20T00:00:02.000Z",
          },
        ]}
      />,
    );

    expect(container.querySelector("[data-step-graph-scroll]")).toHaveClass("py-5");
    expect(container.querySelector("[data-step-graph-item]")).toHaveClass("min-h-[132px]");
  });

  it("renders a compact vertical gstack stage list when provided", () => {
    const { container } = render(
      <RunStepGraph
        copy={adminCopy.ko}
        locale="ko"
        currentPhase="Implementing"
        events={[
          {
            id: "1",
            phase: "Implementing",
            event_type: "worker.started",
            source: "worker",
            message: "runner started",
            created_at: "2026-06-20T00:00:05.000Z",
          },
        ]}
        stageStates={[
          { index: 1, key: "plan", status: "complete", startMs: 0, endMs: 1 },
          { index: 2, key: "implement", status: "active", startMs: 1, endMs: null },
          { index: 3, key: "review", status: "pending", startMs: null, endMs: null },
          { index: 4, key: "verify", status: "pending", startMs: null, endMs: null },
          { index: 5, key: "document", status: "pending", startMs: null, endMs: null },
        ]}
      />,
    );

    const subTrack = screen.getByRole("list", { name: adminCopy.ko.agentStages });
    // implement is relabelled to avoid clashing with the "구현" phase node.
    expect(within(subTrack).getByText("코드 작성")).toBeInTheDocument();
    expect(within(subTrack).getByText("PR 설명")).toBeInTheDocument();
    // Completed sub-stage uses the ink dot, the active one a small spinner.
    expect(container.querySelector(".bg-forest-ink")).toBeInTheDocument();
    expect(within(subTrack).getByText("코드 작성").closest("li")?.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("marks intermediate standard phases complete when the run is completed", () => {
    render(
      <RunStepGraph
        copy={adminCopy.ko}
        locale="ko"
        currentPhase="Completed"
        events={[
          {
            id: "1",
            phase: "Queued",
            event_type: "job.enqueued",
            source: "api",
            message: "accepted",
            created_at: "2026-06-20T00:00:00.000Z",
          },
          {
            id: "2",
            phase: "Implementing",
            event_type: "worker.started",
            source: "worker",
            message: "runner started",
            created_at: "2026-06-20T00:00:05.000Z",
          },
          {
            id: "3",
            phase: "Completed",
            event_type: "worker.completed",
            source: "worker",
            message: "pull request opened",
            created_at: "2026-06-20T00:00:30.000Z",
          },
        ]}
      />,
    );

    const graph = screen.getByRole("list", { name: "처리 단계 그래프" });

    expect(within(graph).getByRole("button", { name: "계획 완료" })).toBeInTheDocument();
    expect(within(graph).getByRole("button", { name: "정책 검사 완료" })).toBeInTheDocument();
    expect(within(graph).getByRole("button", { name: "게시 완료" })).toBeInTheDocument();
    expect(within(graph).queryByText("건너뜀")).not.toBeInTheDocument();
  });
});
