-- 0001: enforce one pull_requests row per (repository, pr_number).
--
-- Before this constraint a single (repository, pr_number) could map to multiple
-- pull_requests rows, so the merge webhook's "latest row wins" lookup was
-- ambiguous and savePullRequest could insert duplicates (republish / orphan
-- branches). The unique index makes the merge webhook resolve to exactly one job.
--
-- Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS is a no-op when already present,
-- so this migration (and the schema.sql baseline that declares the same index)
-- can both be applied without error.
--
-- NOTE: on a database that already contains duplicate (repository, pr_number)
-- rows this CREATE will fail. That is intentional — duplicates must be reconciled
-- by hand before the invariant can be enforced. Fresh databases and the test
-- suite never hit that case.
create unique index if not exists pull_requests_repo_number_unique
  on pull_requests(repository, pr_number);
