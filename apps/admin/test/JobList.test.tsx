// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobList } from "../src/components/JobList.js";
import { adminCopy } from "../src/i18n.js";

describe("JobList", () => {
  afterEach(() => cleanup());

  it("marks the list aria-busy while loading the first page", () => {
    render(<JobList copy={adminCopy.ko} isLoading={true} jobs={[]} locale="ko" selectedJobId="" onOpenJob={vi.fn()} />);
    expect(screen.getByRole("list")).toHaveAttribute("aria-busy", "true");
  });

  it("keeps the list compact and opens the detail page", () => {
    const onOpenJob = vi.fn();
    const longEvent =
      "git ls-remote --heads https://github.com/example-org/example-repo.git main failed with code 128: fatal: could not read Username for https://github.com because no device or address was available";

    render(
      <JobList
        copy={adminCopy.ko}
        isLoading={false}
        jobs={[
          {
            id: "job_09774cca-aa0f-4134-9093-6cebc794e385",
            repository: "example-org/example-repo",
            target_branch: "main",
            work_branch: "ticket-to-pr/job_09774cca-aa0f-4134-9093-6cebc794e385",
            phase: "Failed",
            outcome: "FailedInternal",
            attempt: 1,
            updated_at: "2026-06-20T00:25:00.000Z",
            last_event: longEvent,
          },
        ]}
        locale="ko"
        selectedJobId=""
        onOpenJob={onOpenJob}
      />,
    );

    const row = screen.getByRole("button", { name: /09774cca-aa0f-4134-9093-6cebc794e385/ });

    expect(screen.queryByText(/git ls-remote/)).not.toBeInTheDocument();
    expect(screen.queryByText("시도")).not.toBeInTheDocument();
    expect(screen.queryByText("main")).not.toBeInTheDocument();

    fireEvent.click(row);

    expect(onOpenJob).toHaveBeenCalledWith("job_09774cca-aa0f-4134-9093-6cebc794e385");
  });

  it("applies the status filter to the visible rows", () => {
    const jobs = [
      {
        id: "job_run_11111111-1111-4111-8111-111111111111",
        repository: "acme/web",
        phase: "Implementing",
        outcome: "Running",
        updated_at: "2026-06-20T00:25:00.000Z",
      },
      {
        id: "job_fail_22222222-2222-4222-8222-222222222222",
        repository: "acme/web",
        phase: "Failed",
        outcome: "FailedInternal",
        updated_at: "2026-06-20T00:26:00.000Z",
      },
      {
        id: "job_done_33333333-3333-4333-8333-333333333333",
        repository: "acme/web",
        phase: "Completed",
        outcome: "Completed",
        updated_at: "2026-06-20T00:27:00.000Z",
      },
    ];

    const { rerender } = render(
      <JobList
        copy={adminCopy.ko}
        isLoading={false}
        jobs={jobs}
        locale="ko"
        selectedJobId=""
        statusFilter="all"
        onOpenJob={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId("job-status-pill")).toHaveLength(3);

    rerender(
      <JobList
        copy={adminCopy.ko}
        isLoading={false}
        jobs={jobs}
        locale="ko"
        selectedJobId=""
        statusFilter="failed"
        onOpenJob={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /22222222-2222-4222-8222-222222222222/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /11111111-1111-4111-8111-111111111111/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /33333333-3333-4333-8333-333333333333/ })).not.toBeInTheDocument();
  });

  it("shows a cancel-in-flight job as cancelled, not running", () => {
    render(
      <JobList
        copy={adminCopy.ko}
        isLoading={false}
        jobs={[
          {
            // The backend keeps outcome="Running" until the cancel finalizes.
            id: "job_cancelling_11111111-1111-4111-8111-111111111111",
            repository: "acme/web",
            phase: "CancelRequested",
            outcome: "Running",
            updated_at: "2026-06-20T00:25:00.000Z",
          },
          {
            id: "job_cancelled_22222222-2222-4222-8222-222222222222",
            repository: "acme/web",
            phase: "Cancelled",
            outcome: "Cancelled",
            updated_at: "2026-06-20T00:26:00.000Z",
          },
        ]}
        locale="ko"
        selectedJobId=""
        onOpenJob={vi.fn()}
      />,
    );

    const cancellingRow = screen.getByRole("button", { name: /11111111-1111-4111-8111-111111111111/ });
    expect(cancellingRow).not.toHaveAttribute("data-state", "running");
    expect(within(cancellingRow).queryByRole("status", { name: "실행 중" })).not.toBeInTheDocument();
    expect(within(cancellingRow).getByText("취소됨")).toBeInTheDocument();
    expect(within(cancellingRow).queryByText("실행 중")).not.toBeInTheDocument();

    const cancelledRow = screen.getByRole("button", { name: /22222222-2222-4222-8222-222222222222/ });
    expect(within(cancelledRow).getByText("취소됨")).toBeInTheDocument();
  });

  it("highlights running jobs with an animated status indicator", () => {
    render(
      <JobList
        copy={adminCopy.ko}
        isLoading={false}
        jobs={[
          {
            id: "job_running_11111111-1111-4111-8111-111111111111",
            repository: "example-org/example-repo",
            phase: "Implementing",
            outcome: "Running",
            updated_at: "2026-06-20T00:25:00.000Z",
          },
          {
            id: "job_done_22222222-2222-4222-8222-222222222222",
            repository: "example-org/example-repo",
            phase: "Completed",
            outcome: "NeedsReview",
            updated_at: "2026-06-20T00:26:00.000Z",
          },
          {
            id: "job_failed_33333333-3333-4333-8333-333333333333",
            repository: "example-org/example-repo",
            phase: "Failed",
            outcome: "FailedInternal",
            updated_at: "2026-06-20T00:27:00.000Z",
          },
        ]}
        locale="ko"
        selectedJobId=""
        onOpenJob={vi.fn()}
      />,
    );

    const runningRow = screen.getByRole("button", { name: /11111111-1111-4111-8111-111111111111/ });
    const completedRow = screen.getByRole("button", { name: /22222222-2222-4222-8222-222222222222/ });
    const failedRow = screen.getByRole("button", { name: /33333333-3333-4333-8333-333333333333/ });

    expect(runningRow).toHaveAttribute("data-state", "running");
    expect(within(runningRow).getByRole("status", { name: "실행 중" })).toHaveClass("animate-spin");
    expect(within(runningRow).getAllByTestId("job-status-pill")).toHaveLength(1);
    expect(within(runningRow).getByText("구현 중")).toBeInTheDocument();
    expect(within(runningRow).queryByText("실행 중")).not.toBeInTheDocument();
    expect(completedRow).not.toHaveAttribute("data-state", "running");
    expect(within(completedRow).queryByRole("status", { name: "실행 중" })).not.toBeInTheDocument();
    expect(within(completedRow).getAllByTestId("job-status-pill")).toHaveLength(1);
    expect(within(completedRow).getByText("PR 리뷰 대기중")).toBeInTheDocument();
    expect(within(completedRow).queryByText("완료")).not.toBeInTheDocument();
    expect(within(failedRow).getAllByTestId("job-status-pill")).toHaveLength(1);
    const failurePill = within(failedRow).getByText("내부 실패");
    expect(failurePill).toBeInTheDocument();
    expect(failurePill).toHaveClass("bg-danger-wash", "text-danger", "border-danger");
    expect(failurePill).not.toHaveClass("bg-forest-ink");
    expect(within(failedRow).queryByText("실패")).not.toBeInTheDocument();
  });

  it("distinguishes a Queued job from an actively running one (no spinner, own label)", () => {
    render(
      <JobList
        copy={adminCopy.ko}
        isLoading={false}
        jobs={[
          {
            id: "job_queued_11111111-1111-4111-8111-111111111111",
            repository: "acme/web",
            phase: "Queued",
            outcome: "Running",
            updated_at: "2026-06-20T00:25:00.000Z",
          },
          {
            id: "job_running_22222222-2222-4222-8222-222222222222",
            repository: "acme/web",
            phase: "Implementing",
            outcome: "Running",
            updated_at: "2026-06-20T00:26:00.000Z",
          },
        ]}
        locale="ko"
        selectedJobId=""
        onOpenJob={vi.fn()}
      />,
    );

    const queuedRow = screen.getByRole("button", { name: /11111111-1111-4111-8111-111111111111/ });
    // Queued is NOT treated as an active run: distinct data-state, its own label,
    // and crucially NO spinning status role (color/motion-independent).
    expect(queuedRow).toHaveAttribute("data-state", "queued");
    expect(within(queuedRow).getByText("대기열")).toBeInTheDocument();
    expect(within(queuedRow).queryByRole("status")).not.toBeInTheDocument();
    expect(within(queuedRow).getByLabelText("대기열")).toBeInTheDocument();

    const runningRow = screen.getByRole("button", { name: /22222222-2222-4222-8222-222222222222/ });
    expect(runningRow).toHaveAttribute("data-state", "running");
    expect(within(runningRow).getByRole("status", { name: "실행 중" })).toHaveClass("animate-spin");
  });

  it("falls back to stacked cards on a narrow viewport", () => {
    const matchMediaMock = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal("matchMedia", matchMediaMock);

    try {
      render(
        <JobList
          copy={adminCopy.ko}
          isLoading={false}
          jobs={[
            {
              id: "job_card_11111111-1111-4111-8111-111111111111",
              repository: "acme/web",
              phase: "Implementing",
              outcome: "Running",
              updated_at: "2026-06-20T00:25:00.000Z",
            },
          ]}
          locale="ko"
          selectedJobId=""
          onOpenJob={vi.fn()}
        />,
      );

      // The wide table header columns are gone; the row still renders (as a card),
      // exactly once (no duplicate table+card trees).
      expect(screen.queryByText(adminCopy.ko.tableOutcome)).not.toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /11111111-1111-4111-8111-111111111111/ })).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
