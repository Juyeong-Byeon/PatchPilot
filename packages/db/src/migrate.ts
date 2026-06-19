import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(connectionString: string): Promise<void> {
  const pool = createPool(connectionString);
  try {
    const sql = readFileSync(join(here, "schema.sql"), "utf8");
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  await migrate(connectionString);
}
