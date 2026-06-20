// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunTimeline } from "../src/components/RunTimeline.js";
import { adminCopy } from "../src/i18n.js";

describe("RunTimeline", () => {
  afterEach(() => cleanup());

  it("renders a trace flow table with phase rows and failure context", () => {
    render(
      <RunTimeline
        copy={adminCopy.ko}
        locale="ko"
        events={[
          {
            id: "1",
            phase: "Queued",
            event_type: "job.enqueued",
            source: "api",
            message: "accepted",
            attempt: 1,
            created_at: "2026-06-20T00:00:00.000Z",
          },
          {
            id: "2",
            phase: "Implementing",
            event_type: "worker.started",
            source: "worker",
            message: "clone started",
            attempt: 1,
            created_at: "2026-06-20T00:00:05.000Z",
          },
          {
            id: "3",
            phase: "Implementing",
            event_type: "worker.failed",
            source: "worker",
            message: "git authentication failed",
            attempt: 1,
            created_at: "2026-06-20T00:00:12.000Z",
          },
        ]}
      />,
    );

    const flow = screen.getByRole("region", { name: "실행 흐름" });
    const table = within(flow).getByRole("table", { name: "실행 흐름" });

    expect(within(table).getByText("#")).toBeInTheDocument();
    expect(within(table).getByText("단계")).toBeInTheDocument();
    expect(within(table).getAllByText("대기").length).toBeGreaterThan(0);
    expect(within(table).getByText("구현")).toBeInTheDocument();
    expect(within(table).getByText("실패 지점")).toBeInTheDocument();
    expect(within(table).queryByText("이벤트")).not.toBeInTheDocument();
    expect(within(table).queryByText("2 이벤트")).not.toBeInTheDocument();
    expect(within(flow).queryByText("git authentication failed")).not.toBeInTheDocument();
    expect(screen.queryByText("git authentication failed")).not.toBeInTheDocument();
  });

  it("keeps the active trace duration and duration bar live", () => {
    const { container, rerender } = render(
      <RunTimeline
        copy={adminCopy.ko}
        locale="ko"
        currentPhase="Implementing"
        nowMs={Date.parse("2026-06-20T00:00:15.000Z")}
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

    const firstWidth = container
      .querySelector('[data-phase="Implementing"] [data-duration-bar]')
      ?.getAttribute("style");
    expect(screen.getByText("10s")).toBeInTheDocument();

    rerender(
      <RunTimeline
        copy={adminCopy.ko}
        locale="ko"
        currentPhase="Implementing"
        nowMs={Date.parse("2026-06-20T00:00:25.000Z")}
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

    const secondWidth = container
      .querySelector('[data-phase="Implementing"] [data-duration-bar]')
      ?.getAttribute("style");
    expect(screen.getByText("20s")).toBeInTheDocument();
    expect(secondWidth).not.toEqual(firstWidth);
  });

  it("keeps the current phase live even before a phase event is recorded", () => {
    const { container, rerender } = render(
      <RunTimeline
        copy={adminCopy.ko}
        locale="ko"
        currentPhase="Implementing"
        nowMs={Date.parse("2026-06-20T00:00:15.000Z")}
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
            message: "worker started",
            created_at: "2026-06-20T00:00:05.000Z",
          },
        ]}
      />,
    );

    const activeRow = container.querySelector('[data-phase="Implementing"]');
    expect(activeRow).toHaveAttribute("data-status", "active");
    expect(within(activeRow as HTMLElement).getByText("진행 중")).toBeInTheDocument();
    expect(within(activeRow as HTMLElement).getByText("10s")).toBeInTheDocument();

    rerender(
      <RunTimeline
        copy={adminCopy.ko}
        locale="ko"
        currentPhase="Implementing"
        nowMs={Date.parse("2026-06-20T00:00:25.000Z")}
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
            message: "worker started",
            created_at: "2026-06-20T00:00:05.000Z",
          },
        ]}
      />,
    );

    expect(
      within(container.querySelector('[data-phase="Implementing"]') as HTMLElement).getByText("20s"),
    ).toBeInTheDocument();
  });

  it("shows terminal failure on the last running phase instead of a final Failed row", () => {
    const { container } = render(
      <RunTimeline
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

    const failedImplementing = container.querySelector('[data-phase="Implementing"][data-status="failed"]');

    expect(failedImplementing).toBeInTheDocument();
    expect(container.querySelector('[data-phase="Failed"]')).not.toBeInTheDocument();
    expect(within(failedImplementing as HTMLElement).getByText("실패 지점")).toBeInTheDocument();
    expect(container.querySelector(".bg-danger")).toBeInTheDocument();
  });
});
