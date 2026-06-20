import { describe, expect, it, vi } from "vitest";
import { buildLarkRecordFields, createLarkRecordUpdater, readLarkRecordUpdaterConfig } from "../src/lark-status.js";

describe("Lark status write-back", () => {
  it("reads write-back config only when all required values are present", () => {
    expect(readLarkRecordUpdaterConfig({})).toBeUndefined();

    expect(() =>
      readLarkRecordUpdaterConfig({
        LARK_APP_ID: "cli_app",
        LARK_APP_SECRET: "secret",
        LARK_BASE_APP_TOKEN: "base_token",
      }),
    ).toThrow("Incomplete Lark status update config: LARK_BASE_TABLE_ID");

    expect(
      readLarkRecordUpdaterConfig({
        LARK_APP_ID: "cli_app",
        LARK_APP_SECRET: "secret",
        LARK_BASE_APP_TOKEN: "base_token",
        LARK_BASE_TABLE_ID: "table_id",
      }),
    ).toMatchObject({
      appId: "cli_app",
      appSecret: "secret",
      baseAppToken: "base_token",
      tableId: "table_id",
      apiBaseUrl: "https://open.larksuite.com",
      fieldMapping: {
        statusField: "PatchPilot Status",
        jobIdField: "PatchPilot Job ID",
        prUrlField: "PR URL",
        prNumberField: "PR Number",
        failureReasonField: "PatchPilot Failure",
        updatedAtField: "PatchPilot Updated At",
      },
    });
  });

  it("maps status updates to configured Lark fields", () => {
    const fields = buildLarkRecordFields(
      {
        recordId: "rec_1",
        status: "NeedsReview",
        jobId: "job_1",
        prUrl: "https://github.com/acme/web/pull/42",
        prNumber: 42,
        failureReason: "policy blocked",
      },
      {
        statusField: "Status",
        jobIdField: "Job",
        prUrlField: "PR",
        prNumberField: "PR Number",
        failureReasonField: "Failure",
        updatedAtField: "Updated",
      },
    );

    expect(fields).toEqual({
      Status: "NeedsReview",
      Job: "job_1",
      PR: "https://github.com/acme/web/pull/42",
      "PR Number": 42,
      Failure: "policy blocked",
      Updated: expect.any(String),
    });
  });

  it("patches the Lark Base record using a tenant access token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }),
        text: async () => "",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0 }),
        text: async () => "",
      });

    const updater = createLarkRecordUpdater(
      {
        appId: "cli_app",
        appSecret: "secret",
        baseAppToken: "base_token",
        tableId: "table_id",
        apiBaseUrl: "https://lark.example",
        fieldMapping: {
          statusField: "Status",
          jobIdField: "Job",
          prUrlField: "PR",
          prNumberField: "PR Number",
          updatedAtField: "Updated",
        },
      },
      fetchImpl,
    );

    await updater({
      recordId: "rec_1",
      status: "Completed",
      jobId: "job_1",
      prUrl: "https://github.com/acme/web/pull/42",
      prNumber: 42,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://lark.example/open-apis/auth/v3/tenant_access_token/internal",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ app_id: "cli_app", app_secret: "secret" }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://lark.example/open-apis/bitable/v1/apps/base_token/tables/table_id/records/rec_1",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ authorization: "Bearer tenant-token" }),
      }),
    );
    const patchBody = JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string) as { fields: Record<string, unknown> };
    expect(patchBody.fields).toMatchObject({
      Status: "Completed",
      Job: "job_1",
      PR: "https://github.com/acme/web/pull/42",
      "PR Number": 42,
      Updated: expect.any(String),
    });
  });
});
