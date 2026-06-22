import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type PgPool } from "../src/client.js";
import { migrate } from "../src/migrate.js";
import { Repositories } from "../src/repositories.js";

const connectionString = process.env.DATABASE_URL;

// DATABASE_URL-gated: skips in CI/local without a Postgres connection (like the other
// repository integration tests).
describe.skipIf(!connectionString)("Repositories app settings", () => {
  let pool: PgPool;
  let repos: Repositories;

  beforeAll(async () => {
    await migrate(connectionString!);
    pool = createPool(connectionString!);
    repos = new Repositories(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("returns an empty map when no overrides are persisted", async () => {
    await pool.query("delete from app_settings");
    expect(await repos.getAppSettings()).toEqual({});
  });

  it("upserts overrides with their jsonb type and stamps the actor", async () => {
    await pool.query("delete from app_settings");
    await repos.setAppSettings({ jobTimeoutSeconds: 600 }, "admin");
    expect(await repos.getAppSettings()).toEqual({ jobTimeoutSeconds: 600 });

    // A second write upserts the same key and records updated_by.
    await repos.setAppSettings({ jobTimeoutSeconds: 900 }, "operator");
    expect(await repos.getAppSettings()).toEqual({ jobTimeoutSeconds: 900 });
    const row = await pool.query<{ updated_by: string }>(
      "select updated_by from app_settings where key = 'jobTimeoutSeconds'",
    );
    expect(row.rows[0]?.updated_by).toBe("operator");
  });
});
