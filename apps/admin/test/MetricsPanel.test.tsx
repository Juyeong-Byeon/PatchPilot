// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricsPanel } from "../src/components/MetricsPanel.js";
import { adminCopy } from "../src/i18n.js";

function metricsResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function rawResponse(status: number, contentType = "text/html"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers({ "content-type": contentType }),
    json: async () => {
      throw new Error("not json");
    },
    text: async () => "<html></html>",
  } as Response;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("MetricsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const baseProps = {
    token: "access-key",
    copy: adminCopy.ko,
    sessionExpired: false,
    onSessionExpired: () => undefined,
  };

  it("renders metric tiles and the executor-mode mix when data is present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      metricsResponse({
        totalJobs: 20,
        successRate: 0.85,
        mergeRate: 0.5,
        retryRate: 0.1,
        runtimeP50Ms: 108_000,
        runtimeP95Ms: 990_000,
        executorModeDistribution: { "single-pass": 12, staged: 3 },
      }),
    );

    render(<MetricsPanel {...baseProps} />);
    await flush();

    expect(screen.getByText(adminCopy.ko.metricsTitle)).toBeInTheDocument();
    expect(screen.getByText("85%")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("1m 48s")).toBeInTheDocument(); // p50 108s
    // Executor-mode distribution chips.
    expect(screen.getByText(adminCopy.ko.executorModeSingle)).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("hides the panel on a 404 (endpoint not deployed yet)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(rawResponse(404));
    const { container } = render(<MetricsPanel {...baseProps} />);
    await flush();
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(adminCopy.ko.metricsTitle)).not.toBeInTheDocument();
  });

  it("hides the panel on a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const { container } = render(<MetricsPanel {...baseProps} />);
    await flush();
    expect(container).toBeEmptyDOMElement();
  });

  it("hides the panel when the route answers with non-JSON (SPA fallback)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(rawResponse(200));
    const { container } = render(<MetricsPanel {...baseProps} />);
    await flush();
    expect(container).toBeEmptyDOMElement();
  });

  it("hides the panel when the payload carries no usable fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(metricsResponse({ totalJobs: 0 }));
    const { container } = render(<MetricsPanel {...baseProps} />);
    await flush();
    expect(container).toBeEmptyDOMElement();
  });

  it("routes a 401 to the re-auth boundary and stays hidden", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(rawResponse(401));
    const onSessionExpired = vi.fn();
    const { container } = render(<MetricsPanel {...baseProps} onSessionExpired={onSessionExpired} />);
    await flush();
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not fetch when the session is already expired", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { container } = render(<MetricsPanel {...baseProps} sessionExpired />);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });
});
