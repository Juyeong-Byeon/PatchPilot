// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App.js";

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.pushState(null, "", "/");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders operations console", () => {
    render(<App />);

    expect(screen.getAllByText("PatchPilot").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 1, name: "작업" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "작업" })).toBeInTheDocument();
    expect(screen.getByLabelText("관리자 인증키")).toBeInTheDocument();
  });

  it("polls running job detail including logs every second", async () => {
    vi.useFakeTimers();
    window.localStorage.setItem("ADMIN_TOKEN", "access-key");
    window.history.pushState(null, "", "/jobs/job_1");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const body = url.endsWith("/api/jobs")
        ? [{ id: "job_1", phase: "Implementing", outcome: "Running" }]
        : url.endsWith("/api/jobs/job_1/events")
          ? [
              {
                id: "event_1",
                phase: "Implementing",
                event_type: "worker.started",
                source: "worker",
                created_at: "2026-06-20T00:00:00.000Z",
              },
            ]
          : url.endsWith("/api/jobs/job_1/logs")
            ? [
                {
                  id: "log_1",
                  source: "gstack",
                  stream: "stdout",
                  sequence: 0,
                  text: "running",
                  created_at: "2026-06-20T00:00:00.000Z",
                },
              ]
            : url.endsWith("/api/jobs/job_1/artifacts")
              ? []
              : { id: "job_1", phase: "Implementing", outcome: "Running", repository: "example-org/example-repo" };

      return {
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    });

    render(<App />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("example-org/example-repo")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/jobs/job_1/logs"))).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/jobs/job_1/logs")).length,
    ).toBeGreaterThanOrEqual(2);
  });
});
