import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type PgPool } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));

export interface MigrationFile {
  version: string;
  fileName: string;
}

/**
 * Lists the versioned migration files (numbered `NNNN_*.sql`) in lexical order,
 * which — because the prefix is zero-padded — is also apply order. Pure: reads
 * the directory but touches no database, so the ordering logic is unit-testable.
 */
export function listMigrationFiles(migrationsDir = join(here, "migrations")): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(migrationsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b))
    .map((fileName) => ({ version: fileName.slice(0, fileName.indexOf("_")), fileName }));
}

/**
 * Applies the idempotent schema baseline, then every not-yet-recorded versioned
 * migration exactly once. Re-running is a no-op: the baseline uses IF NOT EXISTS
 * guards and each migration is skipped once its version is in schema_migrations.
 */
export async function migrate(connectionString: string): Promise<void> {
  const pool = createPool(connectionString);
  try {
    await applyBaseline(pool);
    await applyVersionedMigrations(pool);
  } finally {
    await pool.end();
  }
}

async function applyBaseline(pool: PgPool): Promise<void> {
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  await pool.query(sql);
}

async function applyVersionedMigrations(pool: PgPool, migrationsDir = join(here, "migrations")): Promise<void> {
  const files = listMigrationFiles(migrationsDir);
  if (files.length === 0) return;

  const applied = await pool.query<{ version: string }>(`select version from schema_migrations`);
  const appliedVersions = new Set(applied.rows.map((row) => row.version));

  for (const { version, fileName } of files) {
    if (appliedVersions.has(version)) continue;
    const sql = readFileSync(join(migrationsDir, fileName), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(`insert into schema_migrations(version) values ($1) on conflict (version) do nothing`, [
        version,
      ]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  await migrate(connectionString);
}
