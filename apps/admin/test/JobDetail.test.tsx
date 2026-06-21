// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobDetail } from "../src/components/JobDetail.js";
import { adminCopy } from "../src/i18n.js";

const baseProps = {
  events: [],
  logs: [],
  artifacts: [],
  isLoading: false,
  actionState: "",
  nowMs: Date.parse("2026-06-20T00:00:00.000Z"),
  copy: adminCopy.ko,
  locale: "ko" as const,
  onRetry: vi.fn(),
  onCancel: vi.fn(),
};

describe("JobDetail", () => {
  afterEach(() => cleanup());

  it("only enables retry for failed terminal jobs", () => {
    const { rerender } = render(
      <JobDetail {...baseProps} job={{ id: "job_1", phase: "Completed", outcome: "NeedsReview" }} />,
    );

    expect(screen.getByRole("button", { name: "재시도" })).toBeDisabled();

    rerender(<JobDetail {...baseProps} job={{ id: "job_1", phase: "Failed", outcome: "FailedInternal" }} />);

    expect(screen.getByRole("button", { name: "재시도" })).toBeEnabled();

    // Policy-blocked (FailedActionable) jobs are not retryable by the backend, so
    // the button must stay disabled instead of triggering a 409.
    rerender(<JobDetail {...baseProps} job={{ id: "job_1", phase: "Failed", outcome: "FailedActionable" }} />);

    expect(screen.getByRole("button", { name: "재시도" })).toBeDisabled();
  });

  it("renders a detail-scoped error alert near the detail view", () => {
    render(
      <JobDetail
        {...baseProps}
        job={{ id: "job_1", phase: "Implementing", outcome: "Running" }}
        error="작업 상세를 불러오지 못했습니다."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("작업 상세를 불러오지 못했습니다.");
  });

  it("uses danger colors for all failure badges", () => {
    render(
      <JobDetail
        {...baseProps}
        job={{
          id: "job_1",
          phase: "Failed",
          outcome: "FailedInternal",
          failure_category: "github_auth",
        }}
      />,
    );

    const outcome = screen.getByText("내부 실패");
    const category = screen.getByText("github_auth");

    expect(outcome).toHaveClass("bg-danger-wash", "text-danger", "border-danger");
    expect(outcome).not.toHaveClass("bg-forest-ink");
    expect(category).toHaveClass("bg-danger-wash", "text-danger", "border-danger");
    expect(category).not.toHaveClass("bg-forest-ink");
  });

  it("can render an empty detail state and then hydrate the job after refresh", () => {
    const { rerender } = render(<JobDetail {...baseProps} isLoading job={null} />);

    expect(screen.getByText("작업 상세를 불러오는 중입니다.")).toBeInTheDocument();

    rerender(
      <JobDetail
        {...baseProps}
        job={{ id: "job_1", phase: "Planning", outcome: "Running", repository: "example-org/example-repo" }}
      />,
    );

    expect(screen.getByText("example-org/example-repo")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "취소" }).some((button) => !button.hasAttribute("disabled"))).toBe(
      true,
    );
  });

  it("shows the latest retry attempt as current when an earlier attempt failed", () => {
    render(
      <JobDetail
        {...baseProps}
        job={{
          id: "job_1",
          phase: "Completed",
          outcome: "NeedsReview",
          repository: "example-org/example-repo",
          attempt: 2,
        }}
        events={[
          {
            id: "event_1",
            phase: "Queued",
            event_type: "job.enqueued",
            source: "api",
            message: "Queued",
            created_at: "2026-06-20T00:00:00.000Z",
          },
          {
            id: "event_2",
            run_id: "run_1",
            attempt: 1,
            phase: "Failed",
            event_type: "worker.error",
            source: "worker",
            message: "old runner failure",
            created_at: "2026-06-20T00:00:10.000Z",
          },
          {
            id: "event_3",
            run_id: "run_2",
            attempt: 2,
            phase: "Planning",
            event_type: "worker.started",
            source: "worker",
            message: "retry started",
            created_at: "2026-06-20T00:01:00.000Z",
          },
          {
            id: "event_4",
            run_id: "run_2",
            attempt: 2,
            phase: "Completed",
            event_type: "worker.completed",
            source: "worker",
            message: "retry completed",
            created_at: "2026-06-20T00:01:05.000Z",
          },
        ]}
        logs={[
          {
            id: "log_1",
            run_id: "run_1",
            source: "gstack",
            stream: "stderr",
            sequence: 0,
            text: "gstack failed with exit code 1",
            created_at: "2026-06-20T00:00:10.000Z",
          },
          {
            id: "log_2",
            run_id: "run_2",
            source: "gstack",
            stream: "stdout",
            sequence: 0,
            text: "Runner completed successfully",
            created_at: "2026-06-20T00:01:05.000Z",
          },
        ]}
        artifacts={[
          {
            id: "artifact_1",
            run_id: "run_1",
            kind: "agent-result",
            content: { failure: "old failed attempt" },
            created_at: "2026-06-20T00:00:10.000Z",
          },
          {
            id: "artifact_2",
            run_id: "run_2",
            kind: "policy-gate",
            content: { status: "passed" },
            created_at: "2026-06-20T00:01:05.000Z",
          },
        ]}
      />,
    );

    expect(screen.queryByText("실패 지점")).not.toBeInTheDocument();
    expect(screen.queryByText(/gstack failed with exit code 1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/old failed attempt/)).not.toBeInTheDocument();
    expect(screen.getByText(/Runner completed successfully/)).toBeInTheDocument();
    expect(screen.getByText(/"status": "passed"/)).toBeInTheDocument();
  });

  it("focuses the running phase when opening an active job detail", async () => {
    const { container } = render(
      <JobDetail
        {...baseProps}
        nowMs={Date.parse("2026-06-20T00:00:15.000Z")}
        job={{
          id: "job_1",
          phase: "Implementing",
          outcome: "Running",
          repository: "example-org/example-repo",
          attempt: 1,
        }}
        events={[
          {
            id: "event_1",
            phase: "Queued",
            event_type: "job.enqueued",
            source: "api",
            message: "Queued",
            created_at: "2026-06-20T00:00:00.000Z",
          },
          {
            id: "event_2",
            run_id: "run_1",
            attempt: 1,
            phase: "Planning",
            event_type: "worker.started",
            source: "worker",
            message: "Worker picked up job",
            created_at: "2026-06-20T00:00:05.000Z",
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-phase="Implementing"]')).toHaveAttribute("aria-selected", "true");
    });
    expect(screen.getByRole("button", { name: "구현 진행 중" })).toBeInTheDocument();
  });

  it("renders the agent sub-stage track from gstack.stage events while running", () => {
    render(
      <JobDetail
        {...baseProps}
        job={{ id: "job_1", phase: "Implementing", outcome: "Running", repository: "example-org/example-repo" }}
        events={[
          stageEvent("event_1", 1, "plan", "2026-06-20T00:00:00.000Z"),
          stageEvent("event_2", 2, "implement", "2026-06-20T00:00:05.000Z"),
          stageEvent("event_3", 3, "review", "2026-06-20T00:00:10.000Z"),
        ]}
      />,
    );

    // Brand-free heading, with the implement stage relabelled to avoid clashing
    // with the platform "구현" phase chip.
    expect(screen.getByText("에이전트 단계")).toBeInTheDocument();
    expect(screen.getByText("코드 작성")).toBeInTheDocument();
    expect(screen.getByText("검증")).toBeInTheDocument();
  });

  it("renders the final PR-description stage label for a completed staged run", () => {
    render(
      <JobDetail
        {...baseProps}
        job={{ id: "job_1", phase: "Completed", outcome: "NeedsReview", repository: "example-org/example-repo" }}
        events={[
          stageEvent("event_1", 1, "plan", "2026-06-20T00:00:00.000Z"),
          stageEvent("event_2", 2, "implement", "2026-06-20T00:00:05.000Z"),
          stageEvent("event_3", 3, "review", "2026-06-20T00:00:10.000Z"),
          stageEvent("event_4", 4, "verify", "2026-06-20T00:00:15.000Z"),
          stageEvent("event_5", 5, "document", "2026-06-20T00:00:20.000Z"),
        ]}
      />,
    );

    expect(screen.getByText("PR 설명")).toBeInTheDocument();
  });

  it("hides the agent sub-stage track for non-staged runs that emit no stage events", () => {
    render(
      <JobDetail
        {...baseProps}
        job={{ id: "job_1", phase: "Implementing", outcome: "Running", repository: "example-org/example-repo" }}
        events={[
          {
            id: "event_1",
            phase: "Implementing",
            event_type: "runner.started",
            source: "gstack",
            message: "AI runner started",
            created_at: "2026-06-20T00:00:00.000Z",
          },
        ]}
      />,
    );

    expect(screen.queryByText("에이전트 단계")).not.toBeInTheDocument();
  });
});

function stageEvent(id: string, index: number, key: string, createdAt: string) {
  return {
    id,
    run_id: "run_1",
    phase: "Implementing",
    event_type: "gstack.stage",
    source: "gstack",
    message: `gstack stage ${index}/5: ${key}`,
    metadata: { stageIndex: index, stageTotal: 5, stageKey: key },
    created_at: createdAt,
  };
}
