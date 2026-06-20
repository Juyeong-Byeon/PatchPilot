// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LogViewer } from "../src/components/LogViewer.js";
import { adminCopy } from "../src/i18n.js";

describe("LogViewer", () => {
  it("renders progress logs as simplified operator text", () => {
    render(
      <LogViewer
        copy={adminCopy.ko}
        logs={[
          {
            id: "log_1",
            source: "gstack",
            stream: "progress",
            sequence: 0,
            text: "[구현] 실행 워크스페이스를 준비하고 AI runner를 시작합니다.",
            created_at: "2026-06-20T00:00:00.000Z"
          }
        ]}
      />
    );

    const output = screen.getByText(/\[구현\]/);

    expect(output.textContent).toContain("[2026-06-20T00:00:00.000Z] [구현] 실행 워크스페이스를 준비하고 AI runner를 시작합니다.");
    expect(output.textContent).not.toContain("gstack/progress");
  });
});
