// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JobList } from "../src/components/JobList.js";
import { adminCopy } from "../src/i18n.js";

describe("JobList", () => {
  it("keeps long operational messages compact and opens the detail page", () => {
    const onOpenJob = vi.fn();
    const longEvent =
      "git ls-remote --heads https://github.com/Juyeong-Byeon/test_pr_repo.git main failed with code 128: fatal: could not read Username for https://github.com because no device or address was available";

    render(
      <JobList
        copy={adminCopy.ko}
        isLoading={false}
        jobs={[
          {
            id: "job_09774cca-aa0f-4134-9093-6cebc794e385",
            repository: "Juyeong-Byeon/test_pr_repo",
            target_branch: "main",
            work_branch: "ticket-to-pr/job_09774cca-aa0f-4134-9093-6cebc794e385",
            phase: "Failed",
            outcome: "FailedInternal",
            attempt: 1,
            updated_at: "2026-06-20T00:25:00.000Z",
            last_event: longEvent
          }
        ]}
        locale="ko"
        selectedJobId=""
        onOpenJob={onOpenJob}
      />
    );

    const row = screen.getByRole("button", { name: /job_09774cc/ });
    const eventSummary = screen.getByTitle(longEvent);

    expect(eventSummary).toHaveTextContent(/\.\.\.$/);

    fireEvent.click(row);

    expect(onOpenJob).toHaveBeenCalledWith("job_09774cca-aa0f-4134-9093-6cebc794e385");
  });
});
