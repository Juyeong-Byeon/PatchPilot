-- 0002: record which executor pipeline ran each attempt.
--
-- Epic D / X3 (mode routing): the worker selects single-pass vs staged by ticket
-- priority. Persisting the chosen mode on the run makes it observable — getJob
-- returns it and the admin renders an executor-mode badge when present.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op when the column already exists,
-- so this migration and the schema.sql baseline (which declares the same column)
-- can both run without error. Nullable with no default: rows created before this
-- migration simply read back NULL and the admin renders no badge.
alter table runs
  add column if not exists executor_mode text;
