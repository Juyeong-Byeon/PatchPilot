-- 0003: persist operator retry guidance on each run attempt.
--
-- Steering / X4 (retry-with-guidance): an operator may attach a guidance note
-- when retrying a failed job. The note is stored on the new run so the
-- worker/runner can read it back (getRunGuidance) and inject it as a steering
-- instruction for that attempt. Permitting a FailedActionable job to be retried
-- (which otherwise only FailedInternal allows) is gated on this note being
-- present so a bare re-run of an actionable failure is still rejected.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op when the column already exists,
-- so this migration and the schema.sql baseline (which declares the same column)
-- can both run without error. Nullable with no default: rows created before this
-- migration simply read back NULL (no guidance).
alter table runs
  add column if not exists guidance text;
