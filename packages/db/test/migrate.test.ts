import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listMigrationFiles } from "../src/migrate.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

describe("migrate / listMigrationFiles", () => {
  it("lists versioned migrations in zero-padded apply order", () => {
    const files = listMigrationFiles(join(srcDir, "migrations"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const versions = files.map((f) => f.version);
    expect([...versions]).toEqual([...versions].sort());
  });

  it("parses the version prefix from the file name", () => {
    const files = listMigrationFiles(join(srcDir, "migrations"));
    expect(files[0]).toMatchObject({ version: "0001" });
    expect(files[0].fileName).toMatch(/^0001_.*\.sql$/);
  });

  it("includes the pull_requests (repository, pr_number) unique migration", () => {
    const files = listMigrationFiles(join(srcDir, "migrations"));
    const target = files.find((f) => f.fileName.includes("pull_request"));
    expect(target).toBeDefined();
    const sql = readFileSync(join(srcDir, "migrations", target!.fileName), "utf8");
    expect(sql).toMatch(/create unique index if not exists/i);
    expect(sql).toMatch(/pull_requests\s*\(\s*repository\s*,\s*pr_number\s*\)/i);
  });

  it("includes the runs.executor_mode migration as an idempotent ADD COLUMN", () => {
    const files = listMigrationFiles(join(srcDir, "migrations"));
    const target = files.find((f) => f.fileName.includes("executor_mode"));
    expect(target).toMatchObject({ version: "0002" });
    const sql = readFileSync(join(srcDir, "migrations", target!.fileName), "utf8");
    expect(sql).toMatch(/alter table runs/i);
    expect(sql).toMatch(/add column if not exists executor_mode/i);
  });

  it("includes the runs.guidance retry-guidance migration as an idempotent ADD COLUMN (X4)", () => {
    const files = listMigrationFiles(join(srcDir, "migrations"));
    const target = files.find((f) => f.fileName.includes("guidance"));
    expect(target).toMatchObject({ version: "0003" });
    const sql = readFileSync(join(srcDir, "migrations", target!.fileName), "utf8");
    expect(sql).toMatch(/alter table runs/i);
    expect(sql).toMatch(/add column if not exists guidance/i);
  });

  it("includes the app_settings migration as an idempotent CREATE TABLE", () => {
    const files = listMigrationFiles(join(srcDir, "migrations"));
    const target = files.find((f) => f.fileName.includes("app_settings"));
    expect(target).toMatchObject({ version: "0004" });
    const sql = readFileSync(join(srcDir, "migrations", target!.fileName), "utf8");
    expect(sql).toMatch(/create table if not exists app_settings/i);
    expect(sql).toMatch(/value jsonb not null/i);
  });

  it("includes the jobs.pending_question NeedsInput migration as an idempotent ADD COLUMN", () => {
    const files = listMigrationFiles(join(srcDir, "migrations"));
    const target = files.find((f) => f.fileName.includes("pending_question"));
    expect(target).toMatchObject({ version: "0005" });
    const sql = readFileSync(join(srcDir, "migrations", target!.fileName), "utf8");
    expect(sql).toMatch(/alter table jobs/i);
    expect(sql).toMatch(/add column if not exists pending_question/i);
  });

  it("returns [] when the migrations directory is missing", () => {
    expect(listMigrationFiles(join(srcDir, "does-not-exist"))).toEqual([]);
  });
});

describe("migrate / idempotent schema baseline", () => {
  const schema = readFileSync(join(srcDir, "schema.sql"), "utf8");

  it("guards every create table with IF NOT EXISTS", () => {
    const creates = schema.match(/create table[^;]*/gi) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const stmt of creates) {
      expect(stmt.toLowerCase()).toContain("if not exists");
    }
  });

  it("guards every create index with IF NOT EXISTS", () => {
    const creates = schema.match(/create (unique )?index[^;]*/gi) ?? [];
    for (const stmt of creates) {
      expect(stmt.toLowerCase()).toContain("if not exists");
    }
  });

  it("declares the pull_requests unique index and the webhook/migrations ledgers", () => {
    expect(schema).toMatch(/pull_requests_repo_number_unique/);
    expect(schema).toMatch(/create table if not exists webhook_events/i);
    expect(schema).toMatch(/create table if not exists schema_migrations/i);
  });

  it("declares the app_settings override table in the idempotent baseline", () => {
    expect(schema).toMatch(/create table if not exists app_settings/i);
  });

  it("declares jobs.pending_question for the NeedsInput park in the baseline", () => {
    expect(schema).toMatch(/pending_question text/i);
  });
});
