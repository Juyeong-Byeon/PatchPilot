// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  onAnswer: vi.fn(),
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

  it("announces the in-flight action to screen readers via a polite live region", () => {
    const job = { id: "job_1", phase: "Failed", outcome: "FailedInternal" };
    const { rerender } = render(<JobDetail {...baseProps} job={job} />);

    // Idle: no action in flight → the live region carries no announcement.
    const idleRegions = screen.getAllByRole("status");
    expect(idleRegions.some((region) => region.textContent === adminCopy.ko.retrying)).toBe(false);

    // A retry is dispatched → the header live region voices the retrying copy.
    rerender(<JobDetail {...baseProps} actionState="retry" job={job} />);
    const liveRegions = screen.getAllByRole("status");
    const announced = liveRegions.find((region) => region.textContent === adminCopy.ko.retrying);
    expect(announced).toBeInTheDocument();
    expect(announced).toHaveClass("sr-only");
    expect(announced).toHaveAttribute("aria-live", "polite");
  });

  it("renders the NeedsInput panel with the agent's question and submits the answer", () => {
    const onAnswer = vi.fn();
    render(
      <JobDetail
        {...baseProps}
        onAnswer={onAnswer}
        job={{
          id: "job_1",
          phase: "AwaitingInput",
          outcome: "NeedsInput",
          pending_question: "Should the export be CSV or XLSX?",
        }}
      />,
    );

    // The question is surfaced prominently.
    expect(screen.getByText("Should the export be CSV or XLSX?")).toBeInTheDocument();
    expect(screen.getByText(adminCopy.ko.needsInputSummary)).toBeInTheDocument();

    // The submit button is disabled until a non-empty answer is typed.
    const submit = screen.getByRole("button", { name: adminCopy.ko.needsInputSubmit });
    expect(submit).toBeDisabled();

    const textarea = screen.getByLabelText(adminCopy.ko.needsInputAnswerLabel);
    fireEvent.change(textarea, { target: { value: "Use XLSX." } });
    expect(submit).toBeEnabled();

    fireEvent.click(submit);
    expect(onAnswer).toHaveBeenCalledWith("Use XLSX.");
  });

  it("does not render the NeedsInput panel for a non-parked job", () => {
    render(<JobDetail {...baseProps} job={{ id: "job_1", phase: "Implementing", outcome: "Running" }} />);
    expect(screen.queryByText(adminCopy.ko.needsInputSummary)).not.toBeInTheDocument();
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

  it("surfaces the fetch error in the empty state instead of the select-a-job prompt", () => {
    const { rerender } = render(
      <JobDetail {...baseProps} job={null} isLoading={false} error="작업 상세를 불러오지 못했습니다." />,
    );

    // A failed open with no cached job must show the real error, not the misleading
    // "select a job to inspect…" prompt.
    expect(screen.getByRole("alert")).toHaveTextContent("작업 상세를 불러오지 못했습니다.");
    expect(screen.queryByText(adminCopy.ko.selectJob)).not.toBeInTheDocument();

    // The genuine no-selection case (no error) still shows the select prompt.
    rerender(<JobDetail {...baseProps} job={null} isLoading={false} />);
    expect(screen.getByText(adminCopy.ko.selectJob)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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

    // Compact sub-track lives under the platform "구현" node; no separate card
    // heading, and the implement stage is relabelled to avoid clashing with the
    // platform phase chip.
    expect(screen.getByRole("list", { name: adminCopy.ko.agentStages })).toBeInTheDocument();
    expect(screen.getAllByText("코드 작성").length).toBeGreaterThan(0);
    expect(screen.getAllByText("검증").length).toBeGreaterThan(0);
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

    // Rendered both in the sub-track card and nested under the Implementing node.
    expect(screen.getAllByText("PR 설명").length).toBeGreaterThan(0);
  });

  it("toggles the pipeline stage notes from the Implementing execution span", () => {
    const props = {
      ...baseProps,
      job: { id: "job_1", phase: "Completed", outcome: "NeedsReview", repository: "acme/web" },
      artifacts: [{ id: "art_plan", run_id: "run_1", kind: "gstack-plan", content: "# Plan\n- do the thing" }],
    };
    render(<JobDetail {...props} />);

    const diagnostics = screen.getByText(adminCopy.ko.runDiagnostics).closest("section");
    expect(diagnostics).toBeInTheDocument();

    const flow = within(diagnostics as HTMLElement).getByRole("region", { name: adminCopy.ko.traceFlow });
    const implementingRow = within(flow).getByText("구현").closest("tr");
    expect(implementingRow).toBeInTheDocument();

    // The panel is collapsed until the Implementing row's note toggle is opened.
    expect(within(flow).queryByRole("region", { name: adminCopy.ko.stageNotes })).not.toBeInTheDocument();
    fireEvent.click(within(flow).getByRole("button", { name: adminCopy.ko.stageNotes }));

    const notes = within(diagnostics as HTMLElement).getByRole("region", { name: adminCopy.ko.stageNotes });

    expect(notes).toBeInTheDocument();
    expect(implementingRow).toHaveAttribute("aria-selected", "true");
    expect(
      (implementingRow as HTMLElement).compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps execution diagnostics panels shrinkable after selecting the Implementing span", () => {
    render(
      <JobDetail
        {...baseProps}
        job={{ id: "job_1", phase: "Completed", outcome: "NeedsReview", repository: "acme/web" }}
        events={[
          {
            id: "event_1",
            phase: "Queued",
            event_type: "job.enqueued",
            source: "api",
            created_at: "2026-06-20T00:00:00.000Z",
          },
          {
            id: "event_2",
            phase: "Implementing",
            event_type: "worker.started",
            source: "worker",
            created_at: "2026-06-20T00:01:00.000Z",
          },
          {
            id: "event_3",
            phase: "PolicyChecking",
            event_type: "policy.started",
            source: "worker",
            created_at: "2026-06-20T00:02:00.000Z",
          },
        ]}
        logs={[
          {
            id: "log_1",
            source: "worker",
            stream: "stdout",
            sequence: 1,
            text: `runner-output-${"x".repeat(240)}`,
            created_at: "2026-06-20T00:01:20.000Z",
          },
        ]}
        artifacts={[
          {
            id: "artifact_1",
            kind: "runner-summary",
            content: { output: `artifact-${"y".repeat(240)}` },
            created_at: "2026-06-20T00:01:30.000Z",
          },
        ]}
      />,
    );

    const graph = screen.getByRole("list", { name: adminCopy.ko.stepGraph });
    fireEvent.click(within(graph).getByRole("button", { name: /구현/ }));

    const diagnostics = screen.getByText(adminCopy.ko.runDiagnostics).closest("section");
    expect(diagnostics).toBeInTheDocument();

    expect(within(diagnostics as HTMLElement).getByRole("region", { name: adminCopy.ko.traceFlow })).toHaveClass(
      "min-w-0",
    );
    expect(within(diagnostics as HTMLElement).getByRole("region", { name: adminCopy.ko.logs })).toHaveClass(
      "min-w-0",
      "overflow-hidden",
    );
    expect(within(diagnostics as HTMLElement).getByRole("region", { name: adminCopy.ko.artifacts })).toHaveClass(
      "min-w-0",
      "overflow-hidden",
    );
    expect(within(diagnostics as HTMLElement).getByRole("group", { name: adminCopy.ko.logs })).toHaveClass(
      "break-words",
    );
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

    expect(screen.queryByRole("list", { name: adminCopy.ko.agentStages })).not.toBeInTheDocument();
  });

  it("renders a single primary status badge for a Completed+NeedsReview job", () => {
    render(
      <JobDetail
        {...baseProps}
        job={{ id: "job_1", phase: "Completed", outcome: "NeedsReview", repository: "acme/web" }}
      />,
    );

    // The (Completed, NeedsReview) pair collapses to ONE operator-facing status.
    const status = screen.getByLabelText(adminCopy.ko.primaryStatus);
    expect(status).toHaveTextContent("PR 리뷰 대기중");
    // The status-badge group holds a single primary badge (no second "완료" badge
    // sitting beside it as it did with the old dual-badge contradiction).
    const badgeGroup = status.parentElement as HTMLElement;
    expect(within(badgeGroup).queryByText("완료")).not.toBeInTheDocument();
    expect(within(badgeGroup).getAllByText(/대기|완료|실패|구현/).length).toBe(1);
  });

  it("surfaces a prominent PR-review next action for a NeedsReview job", () => {
    render(
      <JobDetail
        {...baseProps}
        job={{
          id: "job_1",
          phase: "Completed",
          outcome: "NeedsReview",
          repository: "acme/web",
          pr_url: "https://github.com/acme/web/pull/7",
        }}
      />,
    );

    // The operator's next action (review the PR) is a labeled CTA, not just the
    // bare icon button in the action cluster.
    const cta = screen.getByRole("link", { name: adminCopy.ko.reviewOpenPr });
    expect(cta).toHaveAttribute("href", "https://github.com/acme/web/pull/7");
    expect(screen.getByText(adminCopy.ko.reviewHint)).toBeInTheDocument();
  });

  it("does not show the PR-review next action for a running job", () => {
    render(
      <JobDetail
        {...baseProps}
        job={{ id: "job_1", phase: "Implementing", outcome: "Running", repository: "acme/web" }}
      />,
    );
    expect(screen.queryByText(adminCopy.ko.reviewHint)).not.toBeInTheDocument();
  });

  it("renders the ticket / DoD panel as a checklist when DoD is enumerable", () => {
    render(
      <JobDetail
        {...baseProps}
        job={{
          id: "job_1",
          phase: "Completed",
          outcome: "NeedsReview",
          repository: "acme/web",
          title: "완료 항목 일괄 삭제 버튼 추가",
          description: "할 일 목록에서 완료된 항목을 한 번에 지우는 버튼이 필요합니다.",
          definition_of_done: "- 버튼이 보인다\n- 클릭하면 완료 항목이 삭제된다\n- e2e 테스트 통과",
        }}
      />,
    );

    expect(screen.getByText(adminCopy.ko.ticketPanel)).toBeInTheDocument();
    expect(screen.getByText("완료 항목 일괄 삭제 버튼 추가")).toBeInTheDocument();
    const checklist = screen.getByRole("list", { name: adminCopy.ko.definitionOfDone });
    expect(within(checklist).getAllByRole("listitem")).toHaveLength(3);
    expect(within(checklist).getByText("클릭하면 완료 항목이 삭제된다")).toBeInTheDocument();
  });

  it("shows a no-ticket-context fallback when ticket fields are absent", () => {
    render(
      <JobDetail {...baseProps} job={{ id: "job_1", phase: "Planning", outcome: "Running", repository: "acme/web" }} />,
    );
    expect(screen.getByText(adminCopy.ko.noTicketContext)).toBeInTheDocument();
  });

  it("renders the evidence card with a clean protected-path badge and no-verification when tests are skipped", () => {
    render(
      <JobDetail
        {...baseProps}
        job={{
          id: "job_1",
          phase: "Completed",
          outcome: "NeedsReview",
          repository: "acme/web",
          target_branch: "main",
        }}
        artifacts={[
          {
            id: "art_policy",
            run_id: "run_1",
            kind: "policy-gate",
            content: {
              status: "passed",
              repository: "acme/web",
              changedFiles: ["src/a.ts", "src/b.ts"],
              deniedFiles: [],
              reasons: [],
            },
            created_at: "2026-06-20T00:01:00.000Z",
          },
          {
            id: "art_result",
            run_id: "run_1",
            kind: "agent-result",
            content: {
              status: "completed",
              targetBranch: "main",
              baseSha: "7092a07000000000000000000000000000000000",
              headSha: "9a067b6000000000000000000000000000000000",
              changedFiles: ["src/a.ts", "src/b.ts"],
              tests: [{ command: "git diff --name-only", status: "skipped", summary: "no tests run" }],
            },
            created_at: "2026-06-20T00:01:05.000Z",
          },
        ]}
      />,
    );

    expect(screen.getByText(adminCopy.ko.evidenceTitle)).toBeInTheDocument();
    // deniedFiles empty → emphasized "보호경로 위반 0".
    expect(screen.getByText(adminCopy.ko.evidenceProtectedClean)).toBeInTheDocument();
    // Skipped tests must be surfaced as "검증 없음", never as a green pass.
    expect(screen.getAllByText(adminCopy.ko.evidenceTestsSkipped).length).toBeGreaterThan(0);
    expect(screen.queryByText(adminCopy.ko.evidenceTestsPassed)).not.toBeInTheDocument();
    // target branch matches → match badge present.
    expect(screen.getByText(adminCopy.ko.evidenceTargetMatch)).toBeInTheDocument();
  });

  it("warns in the evidence card when protected paths were changed", () => {
    render(
      <JobDetail
        {...baseProps}
        job={{ id: "job_1", phase: "PolicyChecking", outcome: "Running", repository: "acme/web" }}
        artifacts={[
          {
            id: "art_policy",
            run_id: "run_1",
            kind: "policy-gate",
            content: {
              status: "failed",
              repository: "acme/web",
              changedFiles: [".github/workflows/ci.yml"],
              deniedFiles: [".github/workflows/ci.yml"],
              reasons: ["Protected files changed: .github/workflows/ci.yml"],
            },
            created_at: "2026-06-20T00:01:00.000Z",
          },
        ]}
      />,
    );

    expect(screen.getByText(adminCopy.ko.evidenceProtectedViolation(1))).toBeInTheDocument();
    expect(screen.getByText(adminCopy.ko.evidencePolicyFailed)).toBeInTheDocument();
    // The path now appears both in the changed-files deeplink list and the denied
    // list, so allow more than one occurrence.
    expect(screen.getAllByText(".github/workflows/ci.yml").length).toBeGreaterThan(0);
  });

  it("keeps the raw evidence JSON behind a collapsible 원본 보기 toggle", () => {
    render(
      <JobDetail
        {...baseProps}
        job={{ id: "job_1", phase: "Completed", outcome: "NeedsReview", repository: "acme/web" }}
        artifacts={[
          {
            id: "art_policy",
            run_id: "run_1",
            kind: "policy-gate",
            content: { status: "passed", changedFiles: [], deniedFiles: [], reasons: [] },
            created_at: "2026-06-20T00:01:00.000Z",
          },
        ]}
      />,
    );

    // The evidence card's raw region is collapsed until the operator expands it.
    expect(screen.queryByTestId("evidence-raw")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: adminCopy.ko.evidenceShowRaw }));
    const raw = screen.getByTestId("evidence-raw");
    expect(within(raw).getByText(/"status": "passed"/)).toBeInTheDocument();
  });

  it("exposes the scrollable artifact output as a keyboard-focusable, labeled region", () => {
    render(
      <JobDetail
        {...baseProps}
        job={{ id: "job_1", phase: "Completed", outcome: "NeedsReview", repository: "acme/web" }}
        artifacts={[
          {
            id: "artifact_1",
            run_id: "run_1",
            kind: "agent-result",
            content: { status: "passed" },
            created_at: "2026-06-20T00:01:05.000Z",
          },
        ]}
      />,
    );

    // The clipped, scrollable artifact <pre> has no focusable children, so it must
    // itself be keyboard-focusable and named for WCAG 2.1.1 keyboard access.
    const region = screen.getByRole("group", { name: adminCopy.ko.artifacts });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.tagName).toBe("PRE");
  });

  it("renders an executor-mode badge only when the record carries the field", () => {
    const { rerender } = render(
      <JobDetail
        {...baseProps}
        job={{ id: "job_1", phase: "Implementing", outcome: "Running", repository: "acme/web" }}
      />,
    );
    expect(screen.queryByText(adminCopy.ko.executorModeStaged)).not.toBeInTheDocument();

    rerender(
      <JobDetail
        {...baseProps}
        job={{
          id: "job_1",
          phase: "Implementing",
          outcome: "Running",
          repository: "acme/web",
          executor_mode: "staged",
        }}
      />,
    );
    expect(screen.getByText(adminCopy.ko.executorModeStaged)).toBeInTheDocument();
  });

  it("marks long repository, branch, and evidence path text as locally breakable", () => {
    const longRepository = "very-long-organization-name-without-natural-breaks/very-long-repository-name-for-mobile";
    const targetBranch = "feature/mobile-dashboard-layout-with-extra-long-target-branch-name";
    const workBranch = "ticket-to-pr/job_1234567890abcdef1234567890abcdef_attempt_2_with_long_suffix";
    const changedFile =
      "apps/admin/src/components/deeply/nested/mobile/responsive/diagnostics/LongEvidenceFileNameWithNoBreaks.tsx";

    render(
      <JobDetail
        {...baseProps}
        job={{
          id: "job_1",
          phase: "Completed",
          outcome: "NeedsReview",
          repository: longRepository,
          target_branch: targetBranch,
          work_branch: workBranch,
        }}
        artifacts={[
          {
            id: "art_result",
            run_id: "run_1",
            kind: "agent-result",
            content: {
              status: "completed",
              changedFiles: [changedFile],
              tests: [],
            },
            created_at: "2026-06-20T00:01:05.000Z",
          },
        ]}
      />,
    );

    expect(screen.getByText(longRepository)).toHaveClass("break-words", "[overflow-wrap:anywhere]");
    expect(screen.getByText(`${targetBranch} · ${workBranch}`)).toHaveClass("break-words", "[overflow-wrap:anywhere]");
    expect(screen.getByText(changedFile)).toHaveClass("break-all");
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
