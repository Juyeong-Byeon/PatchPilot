// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogViewer } from "../src/components/LogViewer.js";
import { adminCopy } from "../src/i18n.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LOG = {
  id: "log_1",
  source: "gstack",
  stream: "progress",
  sequence: 0,
  text: "[구현] 실행 워크스페이스를 준비하고 AI runner를 시작합니다.",
  created_at: "2026-06-20T00:00:00.000Z",
};

describe("LogViewer", () => {
  it("renders progress logs as simplified operator text", () => {
    render(<LogViewer copy={adminCopy.ko} logs={[LOG]} />);

    const output = screen.getByText(/\[구현\]/);
    expect(output.textContent).toContain(
      "[2026-06-20T00:00:00.000Z] [구현] 실행 워크스페이스를 준비하고 AI runner를 시작합니다.",
    );
    expect(output.textContent).not.toContain("gstack/progress");
  });

  it("confirms with a 'copied' state after the copy button is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<LogViewer copy={adminCopy.ko} jobId="job_1" logs={[LOG]} />);

    fireEvent.click(screen.getByRole("button", { name: adminCopy.ko.copy }));
    expect(writeText).toHaveBeenCalledTimes(1);

    // After the async clipboard write resolves, the button label and the live
    // region both announce the confirmation.
    await waitFor(() => expect(screen.getByRole("button", { name: adminCopy.ko.copied })).toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent(adminCopy.ko.copied);
  });
});
