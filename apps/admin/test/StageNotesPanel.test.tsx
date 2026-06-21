// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StageNotesPanel, isStageNoteArtifact } from "../src/components/StageNotesPanel.js";
import { adminCopy } from "../src/i18n.js";

describe("StageNotesPanel", () => {
  afterEach(() => cleanup());

  it("renders stage notes in pipeline order, collapsed by default, expanding on click", () => {
    render(
      <StageNotesPanel
        copy={adminCopy.ko}
        notes={[
          // intentionally out of order
          { id: "a2", kind: "gstack-review", content: "# Review\n- No blocking issues" },
          { id: "a1", kind: "gstack-plan", content: "# Plan\n- Add endpoint" },
          { id: "a3", kind: "gstack-qa", content: "# QA\n- npm test passed" },
        ]}
      />,
    );

    const headers = screen.getAllByRole("button");
    // plan -> review -> qa regardless of input order
    expect(headers[0]).toHaveTextContent("계획");
    expect(headers[1]).toHaveTextContent("리뷰");
    expect(headers[2]).toHaveTextContent("검증");

    // Collapsed by default: note bodies are not rendered until expanded.
    expect(screen.queryByText("Add endpoint")).not.toBeInTheDocument();
    expect(screen.queryByText("No blocking issues")).not.toBeInTheDocument();

    // Clicking a header expands that note (markdown bullet renders as list text).
    fireEvent.click(headers[0]);
    expect(screen.getByText("Add endpoint")).toBeInTheDocument();
    expect(screen.queryByText("No blocking issues")).not.toBeInTheDocument();
  });

  it("renders nothing when there are no stage-note artifacts", () => {
    const { container } = render(
      <StageNotesPanel copy={adminCopy.ko} notes={[{ id: "x", kind: "agent-result", content: {} }]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("identifies stage-note artifacts by kind", () => {
    expect(isStageNoteArtifact({ kind: "gstack-plan" })).toBe(true);
    expect(isStageNoteArtifact({ kind: "gstack-qa" })).toBe(true);
    expect(isStageNoteArtifact({ kind: "agent-result" })).toBe(false);
    expect(isStageNoteArtifact({ kind: null })).toBe(false);
  });
});
