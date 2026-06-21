-- 0004: operator-editable configuration overrides (Settings page).
--
-- The platform reads all config from env at process start. This table is the
-- DB-override layer: an editable setting (e.g. jobTimeoutSeconds) can be changed
-- here without a redeploy, and the worker resolves the EFFECTIVE value (env ⊕
-- override) per job / per sweep. Each row is one setting keyed by the core settings
-- registry key; the value is stored as jsonb so int/bool/csv/string all round-trip
-- without a per-type column.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS is a no-op when the table already exists,
-- so this migration and the schema.sql baseline (which declares the same table) can
-- both run without error. updated_by records the actor of the last write for audit.
create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
