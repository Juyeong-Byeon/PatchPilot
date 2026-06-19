// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunTimeline } from "../src/components/RunTimeline.js";
import { adminCopy } from "../src/i18n.js";

describe("RunTimeline", () => {
  it("renders a trace flow with phase spans and failure context", () => {
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
            created_at: "2026-06-20T00:00:00.000Z"
          },
          {
            id: "2",
            phase: "Implementing",
            event_type: "worker.started",
            source: "worker",
            message: "clone started",
            attempt: 1,
            created_at: "2026-06-20T00:00:05.000Z"
          },
          {
            id: "3",
            phase: "Implementing",
            event_type: "worker.failed",
            source: "worker",
            message: "git authentication failed",
            attempt: 1,
            created_at: "2026-06-20T00:00:12.000Z"
          }
        ]}
      />
    );

    const flow = screen.getByRole("region", { name: "실행 흐름" });

    expect(within(flow).getAllByText("대기").length).toBeGreaterThan(0);
    expect(within(flow).getByText("구현")).toBeInTheDocument();
    expect(within(flow).getByText("실패 지점")).toBeInTheDocument();
    expect(within(flow).getByText("2 이벤트")).toBeInTheDocument();
    expect(within(flow).getByText("git authentication failed")).toBeInTheDocument();
  });
});
