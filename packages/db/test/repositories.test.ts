import { describe, expect, it } from "vitest";
import { createPool } from "../src/client.js";
import { migrate } from "../src/migrate.js";
import { Repositories } from "../src/repositories.js";

const connectionString = process.env.DATABASE_URL;

describe.skipIf(!connectionString)("Repositories", () => {
  it("deduplicates jobs by lark record and trigger version", async () => {
    await migrate(connectionString!);
    const pool = createPool(connectionString!);
    const repos = new Repositories(pool);
    const suffix = Date.now().toString();
    const ticket = {
      larkRecordId: `rec_${suffix}`,
      triggerVersion: "v1",
      title: "Fix login",
      description: "desc",
      definitionOfDone: "done",
      repository: "acme/web",
      targetBranch: "main",
      priority: "Normal" as const,
      status: "Progress",
      agentRunRequested: true,
      rawFields: {}
    };
    try {
      const first = await repos.createJobFromTicket(ticket, {
        ticketSnapshotId: `ts_${suffix}_1`,
        jobId: `job_${suffix}_1`
      });
      const second = await repos.createJobFromTicket(ticket, {
        ticketSnapshotId: `ts_${suffix}_2`,
        jobId: `job_${suffix}_2`
      });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
    } finally {
      await pool.end();
    }
  });
});
