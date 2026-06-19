// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JobDetail } from "../src/components/JobDetail.js";

const baseProps = {
  events: [],
  logs: [],
  artifacts: [],
  isLoading: false,
  actionState: "",
  onRetry: vi.fn(),
  onCancel: vi.fn()
};

describe("JobDetail", () => {
  it("only enables retry for failed terminal jobs", () => {
    const { rerender } = render(
      <JobDetail
        {...baseProps}
        job={{ id: "job_1", phase: "Completed", outcome: "NeedsReview" }}
      />
    );

    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();

    rerender(
      <JobDetail
        {...baseProps}
        job={{ id: "job_1", phase: "Failed", outcome: "FailedInternal" }}
      />
    );

    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });
});
