// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobRecord } from "../src/api.js";
import { JobList } from "../src/components/JobList.js";
import { adminCopy } from "../src/i18n.js";
import type { StatusFilter } from "../src/lib/status.js";

const UPDATED_AT = "2026-06-20T00:25:00.000Z";

const alphaJobId = "job_alpha_11111111-1111-4111-8111-111111111111";
const betaJobId = "job_beta_22222222-2222-4222-8222-222222222222";
const gammaJobId = "job_gamma_33333333-3333-4333-8333-333333333333";

interface RenderJobListOptions {
  jobs?: JobRecord[];
  selectedJobId?: string;
  isLoading?: boolean;
  statusFilter?: StatusFilter;
  onOpenJob?: (jobId: string) => void;
}

function buildJob(overrides: Partial<JobRecord> & Pick<JobRecord, "id">): JobRecord {
  return {
    repository: "acme/web",
    phase: "Implementing",
    outcome: "Running",
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

function sampleJobs(): JobRecord[] {
  return [
    buildJob({
      id: alphaJobId,
      repository: "Alpha/Todo-API",
      target_branch: "main",
    }),
    buildJob({
      id: betaJobId,
      repository: "Beta/mobile",
      target_branch: "release/ios",
      phase: "Completed",
      outcome: "Completed",
    }),
    buildJob({
      id: gammaJobId,
      repository: "Gamma/docs",
      target_branch: "feature/docs",
      phase: "Failed",
      outcome: "FailedInternal",
    }),
  ];
}

function jobListElement({
  jobs = sampleJobs(),
  selectedJobId = "",
  isLoading = false,
  statusFilter = "all",
  onOpenJob = vi.fn(),
}: RenderJobListOptions = {}) {
  return (
    <JobList
      copy={adminCopy.en}
      isLoading={isLoading}
      jobs={jobs}
      locale="en"
      selectedJobId={selectedJobId}
      statusFilter={statusFilter}
      onOpenJob={onOpenJob}
    />
  );
}

function renderJobList(options: RenderJobListOptions = {}) {
  const onOpenJob = options.onOpenJob ?? vi.fn();
  return {
    onOpenJob,
    ...render(jobListElement({ ...options, onOpenJob })),
  };
}

function filterJobs(query: string) {
  fireEvent.change(screen.getByLabelText(adminCopy.en.filterJobsLabel), { target: { value: query } });
}

function getJobRow(uuid: string) {
  return screen.getByRole("button", { name: new RegExp(uuid) });
}

function queryJobRow(uuid: string) {
  return screen.queryByRole("button", { name: new RegExp(uuid) });
}

describe("JobList", () => {
  afterEach(() => cleanup());

  it("renders the empty-state message when there are no jobs and the list is not loading", () => {
    renderJobList({ jobs: [], isLoading: false });

    expect(screen.getByRole("list")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByText(adminCopy.en.noJobMatches)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("filters visible jobs by repository name", () => {
    renderJobList();

    filterJobs("Alpha/Todo-API");

    expect(getJobRow("11111111-1111-4111-8111-111111111111")).toBeInTheDocument();
    expect(queryJobRow("22222222-2222-4222-8222-222222222222")).not.toBeInTheDocument();
    expect(queryJobRow("33333333-3333-4333-8333-333333333333")).not.toBeInTheDocument();
  });

  it("filters visible jobs by job id UUID suffix", () => {
    renderJobList();

    filterJobs("222222222222");

    expect(queryJobRow("11111111-1111-4111-8111-111111111111")).not.toBeInTheDocument();
    expect(getJobRow("22222222-2222-4222-8222-222222222222")).toBeInTheDocument();
    expect(queryJobRow("33333333-3333-4333-8333-333333333333")).not.toBeInTheDocument();
  });

  it("filters visible jobs by target branch", () => {
    renderJobList();

    filterJobs("release/ios");

    expect(queryJobRow("11111111-1111-4111-8111-111111111111")).not.toBeInTheDocument();
    expect(getJobRow("22222222-2222-4222-8222-222222222222")).toBeInTheDocument();
    expect(queryJobRow("33333333-3333-4333-8333-333333333333")).not.toBeInTheDocument();
  });

  it("trims and applies search case-insensitively", () => {
    renderJobList();

    filterJobs("  alpha/todo-api  ");

    expect(getJobRow("11111111-1111-4111-8111-111111111111")).toBeInTheDocument();
    expect(queryJobRow("22222222-2222-4222-8222-222222222222")).not.toBeInTheDocument();
    expect(queryJobRow("33333333-3333-4333-8333-333333333333")).not.toBeInTheDocument();
  });

  it("shows the empty-state message when search has no matches", () => {
    renderJobList();

    filterJobs("missing repository");

    expect(screen.getByText(adminCopy.en.noJobMatches)).toBeInTheDocument();
    expect(queryJobRow("11111111-1111-4111-8111-111111111111")).not.toBeInTheDocument();
    expect(queryJobRow("22222222-2222-4222-8222-222222222222")).not.toBeInTheDocument();
    expect(queryJobRow("33333333-3333-4333-8333-333333333333")).not.toBeInTheDocument();
  });

  it("marks the selected job row with aria-current", () => {
    renderJobList({ selectedJobId: betaJobId });

    expect(getJobRow("11111111-1111-4111-8111-111111111111")).not.toHaveAttribute("aria-current");
    expect(getJobRow("22222222-2222-4222-8222-222222222222")).toHaveAttribute("aria-current", "page");
  });

  it("includes completed NeedsReview jobs only in the needs-review filter", () => {
    const jobs = [
      buildJob({
        id: alphaJobId,
        phase: "Completed",
        outcome: "NeedsReview",
      }),
      buildJob({
        id: betaJobId,
        phase: "Completed",
        outcome: "Completed",
      }),
    ];
    const onOpenJob = vi.fn();
    const { rerender } = render(jobListElement({ jobs, statusFilter: "needsReview", onOpenJob }));

    expect(getJobRow("11111111-1111-4111-8111-111111111111")).toBeInTheDocument();
    expect(queryJobRow("22222222-2222-4222-8222-222222222222")).not.toBeInTheDocument();

    rerender(jobListElement({ jobs, statusFilter: "completed", onOpenJob }));

    expect(queryJobRow("11111111-1111-4111-8111-111111111111")).not.toBeInTheDocument();
    expect(getJobRow("22222222-2222-4222-8222-222222222222")).toBeInTheDocument();
  });

  it("includes AwaitingInput jobs only in the needs-input filter", () => {
    const jobs = [
      buildJob({
        id: alphaJobId,
        phase: "AwaitingInput",
        outcome: "NeedsInput",
      }),
      buildJob({
        id: betaJobId,
        phase: "Failed",
        outcome: "FailedActionable",
      }),
      buildJob({
        id: gammaJobId,
        phase: "Completed",
        outcome: "Completed",
      }),
    ];
    const onOpenJob = vi.fn();
    const { rerender } = render(jobListElement({ jobs, statusFilter: "needsInput", onOpenJob }));

    expect(getJobRow("11111111-1111-4111-8111-111111111111")).toBeInTheDocument();
    expect(queryJobRow("22222222-2222-4222-8222-222222222222")).not.toBeInTheDocument();
    expect(queryJobRow("33333333-3333-4333-8333-333333333333")).not.toBeInTheDocument();

    rerender(jobListElement({ jobs, statusFilter: "failed", onOpenJob }));

    expect(queryJobRow("11111111-1111-4111-8111-111111111111")).not.toBeInTheDocument();
    expect(getJobRow("22222222-2222-4222-8222-222222222222")).toBeInTheDocument();
    expect(queryJobRow("33333333-3333-4333-8333-333333333333")).not.toBeInTheDocument();

    rerender(jobListElement({ jobs, statusFilter: "completed", onOpenJob }));

    expect(queryJobRow("11111111-1111-4111-8111-111111111111")).not.toBeInTheDocument();
    expect(queryJobRow("22222222-2222-4222-8222-222222222222")).not.toBeInTheDocument();
    expect(getJobRow("33333333-3333-4333-8333-333333333333")).toBeInTheDocument();
  });

  it("includes failed jobs only in the failed filter", () => {
    const jobs = [
      buildJob({
        id: alphaJobId,
        phase: "Failed",
        outcome: "FailedInternal",
      }),
      buildJob({
        id: betaJobId,
        phase: "Implementing",
        outcome: "Running",
      }),
      buildJob({
        id: gammaJobId,
        phase: "Completed",
        outcome: "Completed",
      }),
    ];

    renderJobList({ jobs, statusFilter: "failed" });

    expect(getJobRow("11111111-1111-4111-8111-111111111111")).toBeInTheDocument();
    expect(queryJobRow("22222222-2222-4222-8222-222222222222")).not.toBeInTheDocument();
    expect(queryJobRow("33333333-3333-4333-8333-333333333333")).not.toBeInTheDocument();
  });

  it("opens the focused job with Enter and Space", () => {
    const { onOpenJob } = renderJobList({ jobs: [buildJob({ id: alphaJobId })] });
    const row = getJobRow("11111111-1111-4111-8111-111111111111");

    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });

    expect(onOpenJob).toHaveBeenNthCalledWith(1, alphaJobId);
    expect(onOpenJob).toHaveBeenNthCalledWith(2, alphaJobId);
    expect(onOpenJob).toHaveBeenCalledTimes(2);
  });

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
