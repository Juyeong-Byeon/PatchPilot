-- 0005: persist the agent's pending question for a NeedsInput (입력 대기) job.
--
-- NeedsInput capability: when the agent is genuinely blocked on a decision only a
-- human can make, it asks ONE question and the job is PARKED at phase=AwaitingInput
-- / outcome=NeedsInput instead of failing. The question is stored here so the admin
-- console can show it and the operator can answer. Set when the worker parks the
-- job; CLEARED when the operator answers (the answer is then persisted as the new
-- run's guidance, reusing the retry-with-guidance plumbing). NULL means no pending
-- question (the normal case for every non-parked job).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op when the column already exists,
-- so this migration and the schema.sql baseline (which declares the same column)
-- can both run without error. Nullable with no default: rows created before this
-- migration simply read back NULL.
alter table jobs
  add column if not exists pending_question text;
