// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunStepGraph } from "../src/components/RunStepGraph.js";
import { adminCopy } from "../src/i18n.js";

describe("RunStepGraph", () => {
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
            created_at: "2026-06-20T00:00:00.000Z"
          },
          {
            id: "2",
            phase: "Implementing",
            event_type: "worker.started",
            source: "worker",
            message: "clone started",
            created_at: "2026-06-20T00:00:05.000Z"
          },
          {
            id: "3",
            phase: "Implementing",
            event_type: "worker.failed",
            source: "worker",
            message: "git authentication failed",
            created_at: "2026-06-20T00:00:12.000Z"
          }
        ]}
      />
    );

    const graph = screen.getByRole("list", { name: "처리 단계 그래프" });

    expect(within(graph).getAllByRole("button")).toHaveLength(6);
    expect(within(graph).getAllByText("대기").length).toBeGreaterThan(0);
    expect(within(graph).getByText("건너뜀")).toBeInTheDocument();
    expect(within(graph).getByText("구현")).toBeInTheDocument();
    expect(within(graph).getByRole("button", { name: "구현 실패 지점" })).toBeInTheDocument();
    expect(within(graph).getByText("실패 지점")).toBeInTheDocument();
    expect(within(graph).getByText(/2 이벤트/)).toBeInTheDocument();
    expect(within(graph).getByText("worker")).toBeInTheDocument();
    expect(within(graph).queryByText("git authentication failed")).not.toBeInTheDocument();
  });
});
