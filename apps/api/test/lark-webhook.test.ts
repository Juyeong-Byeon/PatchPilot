import { describe, expect, it, vi } from "vitest";
import { handleLarkWebhook } from "../src/lark-webhook.js";

describe("handleLarkWebhook", () => {
  it("creates and enqueues a job when trigger conditions match", async () => {
    const repos = {
      createJobFromTicket: vi.fn().mockResolvedValue({ jobId: "job_1", ticketSnapshotId: "ts_1", created: true }),
      appendEvent: vi.fn()
    };
    const queue = { add: vi.fn().mockResolvedValue({ id: "bull_1" }) };

    const result = await handleLarkWebhook(
      {
        recordId: "rec1",
        triggerVersion: "v1",
        fields: {
          Title: "Fix login",
          Description: "desc",
          "Definition of Done": "done",
          Repository: "acme/web",
          "Target Branch": "main",
          Priority: "Normal",
          Status: "Progress",
          "Agent Run Requested": true
        }
      },
      repos as never,
      queue as never
    );

    expect(result).toEqual({ action: "enqueued", jobId: "job_1" });
    expect(queue.add).toHaveBeenCalledWith("job_1", {
      jobId: "job_1",
      ticketSnapshotId: "ts_1",
      larkRecordId: "rec1",
      triggerVersion: "v1"
    });
    expect(repos.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job_1",
        phase: "Queued",
        eventType: "job.enqueued",
        source: "api"
      })
    );
  });
});
