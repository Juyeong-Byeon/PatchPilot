import pg from "pg";

export type PgPool = pg.Pool;

export function createPool(connectionString: string): PgPool {
  return new pg.Pool({ connectionString });
}
