create table if not exists ticket_snapshots (
  id text primary key,
  lark_record_id text not null,
  trigger_version text not null,
  title text not null,
  description text not null,
  definition_of_done text not null,
  repository text not null,
  target_branch text not null,
  priority text not null,
  raw_fields jsonb not null,
  created_at timestamptz not null default now(),
  unique (lark_record_id, trigger_version)
);

create table if not exists jobs (
  id text primary key,
  ticket_snapshot_id text not null references ticket_snapshots(id),
  lark_record_id text not null,
  trigger_version text not null,
  idempotency_key text not null unique,
  outcome text not null,
  phase text not null,
  priority text not null,
  failure_category text,
  failure_reason text,
  next_action text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lark_record_id, trigger_version)
);

create unique index if not exists jobs_one_active_per_record
  on jobs(lark_record_id)
  where phase not in ('Completed', 'Failed', 'Cancelled', 'CancelFailed');

create table if not exists runs (
  id text primary key,
  job_id text not null references jobs(id),
  attempt integer not null,
  container_id text,
  runner_image_digest text,
  workspace_path text,
  base_sha text,
  work_branch text,
  head_sha text,
  exit_code integer,
  -- Pipeline that ran this attempt: 'single-pass' | 'staged' (epic D / X3). Also
  -- added to existing databases by migration 0002.
  executor_mode text,
  heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  unique (job_id, attempt)
);

create table if not exists run_events (
  id bigserial primary key,
  job_id text not null references jobs(id),
  run_id text references runs(id),
  attempt integer,
  phase text not null,
  event_type text not null,
  source text not null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists job_logs (
  id bigserial primary key,
  job_id text not null references jobs(id),
  run_id text references runs(id),
  source text not null,
  stream text not null,
  sequence integer not null,
  redaction_applied boolean not null default false,
  text text not null,
  created_at timestamptz not null default now()
);

create table if not exists artifacts (
  id text primary key,
  job_id text not null references jobs(id),
  run_id text references runs(id),
  kind text not null,
  path text,
  content jsonb,
  created_at timestamptz not null default now()
);

create table if not exists pull_requests (
  id text primary key,
  job_id text not null references jobs(id),
  run_id text not null references runs(id),
  repository text not null,
  target_branch text not null,
  work_branch text not null,
  base_sha text not null,
  head_sha text not null,
  commit_shas jsonb not null,
  pr_url text not null,
  pr_number integer not null,
  pr_title text not null,
  pr_body text not null,
  created_at timestamptz not null default now()
);

-- One pull-request row per (repository, pr_number). Guarantees the merge webhook
-- resolves to a single job and makes savePullRequest collision-safe. Also added by
-- migration 0001 for databases created before this constraint existed.
create unique index if not exists pull_requests_repo_number_unique
  on pull_requests(repository, pr_number);

create table if not exists webhook_events (
  id text primary key,
  provider text not null,
  lark_record_id text,
  trigger_version text,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

create table if not exists audit_events (
  id bigserial primary key,
  actor text not null,
  action text not null,
  job_id text references jobs(id),
  run_id text references runs(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Ledger of applied versioned migrations. The schema.sql baseline is always
-- idempotent and re-runnable; numbered files in migrations/ run exactly once and
-- record their version here.
create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);
