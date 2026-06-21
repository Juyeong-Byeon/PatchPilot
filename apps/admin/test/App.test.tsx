// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

  it("renders operations console once a token is set", () => {
    window.localStorage.setItem("ADMIN_TOKEN", "access-key");
    window.history.pushState(null, "", "/jobs");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse([]));

    render(<App />);

    expect(screen.getAllByText("PatchPilot").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 1, name: "작업" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "작업" })).toBeInTheDocument();
  });

  it("shows the onboarding view and hides the job console when no token is saved", () => {
    render(<App />);

    // Dedicated onboarding gate, not the sidebar+content grid: just the key input + submit.
    expect(screen.getByLabelText("관리자 인증키")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "접속" })).toBeInTheDocument();
    // The normal job console (its level-1 heading + nav button) is not rendered.
    expect(screen.queryByRole("heading", { level: 1, name: "작업" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "작업" })).not.toBeInTheDocument();
  });

  it("keeps the sidebar minimal: theme toggle only, no token input or locale control", async () => {
    window.localStorage.setItem("ADMIN_TOKEN", "access-key");
    window.history.pushState(null, "", "/jobs");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse([]));

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Theme segmented control still lives in the sidebar.
    const themeGroup = screen.getByRole("group", { name: "테마" });
    expect(within(themeGroup).getByRole("button", { name: "라이트" })).toBeInTheDocument();

    // Account/auth + locale moved to Settings: neither the token input, the
    // 인증됨 indicator, nor the locale buttons render in the (default) sidebar view.
    expect(screen.queryByLabelText("관리자 인증키")).not.toBeInTheDocument();
    expect(screen.queryByText("인증됨")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "한국어" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "English" })).not.toBeInTheDocument();
  });

  it("dismisses onboarding and shows the app after submitting a token", async () => {
    window.history.pushState(null, "", "/jobs");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse([]));

    render(<App />);

    // Onboarding is shown first; fill the access key and submit it.
    const input = screen.getByLabelText("관리자 인증키") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "fresh-key" } });
      fireEvent.submit(input.closest("form")!);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Onboarding gone; the job console is rendered.
    expect(screen.queryByRole("button", { name: "접속" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "작업" })).toBeInTheDocument();
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

  it("renders a Needs Review filter chip distinct from Completed", async () => {
    window.localStorage.setItem("ADMIN_TOKEN", "access-key");
    window.history.pushState(null, "", "/jobs");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const body = url.endsWith("/api/jobs")
        ? [
            { id: "job_review", phase: "Completed", outcome: "NeedsReview", repository: "acme/web" },
            { id: "job_done", phase: "Completed", outcome: "Completed", repository: "acme/web" },
          ]
        : [];
      return jsonResponse(body);
    });

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Scope to the filter chip group so the row's "PR 리뷰 대기중" pill is excluded.
    const filterGroup = screen.getByRole("group", { name: "작업 필터" });
    const reviewChip = within(filterGroup).getByRole("button", { name: /리뷰 대기/ });
    expect(reviewChip).toBeInTheDocument();
    // The Needs-Review chip counts the review job; Completed counts only the merged one.
    expect(reviewChip).toHaveTextContent("1");
    const completedChip = within(filterGroup).getByRole("button", { name: /^완료/ });
    expect(completedChip).toHaveTextContent("1");

    // Activating the chip filters the list down to the review job.
    await act(async () => {
      reviewChip.click();
      await Promise.resolve();
    });
    expect(reviewChip).toHaveAttribute("aria-pressed", "true");
  });

  it("surfaces a single session-expired state and stops polling on a 401", async () => {
    vi.useFakeTimers();
    window.localStorage.setItem("ADMIN_TOKEN", "stale-key");
    window.history.pushState(null, "", "/jobs");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => unauthorizedResponse());

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Single re-auth boundary surfaced (prominent banner + status line), not a
    // silently frozen screen.
    expect(screen.getAllByText("세션 만료 — 재인증 필요").length).toBeGreaterThan(0);
    expect(screen.getByRole("alert")).toHaveTextContent("세션 만료");

    const callsAfterAuthFail = fetchMock.mock.calls.length;
    // Advancing the poll interval must NOT issue further requests while expired.
    await act(async () => {
      vi.advanceTimersByTime(10000);
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterAuthFail);
  });
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function unauthorizedResponse(): Response {
  return {
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ error: "admin_access_key_invalid" }),
    text: async () => "admin_access_key_invalid",
  } as Response;
}
