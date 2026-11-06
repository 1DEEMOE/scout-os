-- 0013: Routines engine (Scout OS increment R1). Additive only.
-- Rollback: packages/db/rollback/0013_routines.down.sql
--
-- A routine is a scheduled, read-mostly job owned by the COORDINATOR. R1 ships one
-- kind, the Morning Briefing, which only reads tenant data and writes its result
-- in-app. Routines may only take tier 0-1 steps (max_tier <= 1, enforced here and in
-- code); anything tier 2+ becomes an ordinary task that goes through approvals.
-- No cross-tenant scanner: each next run is a queued job carrying its tenant id.

CREATE TABLE routines (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('morning_briefing')),
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  agent_kind     text NOT NULL DEFAULT 'coordinator' CHECK (agent_kind IN ('coordinator')),
  -- Wall-clock schedule in an IANA time zone. days_of_week: 0 = Sunday … 6 = Saturday.
  hour           smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  minute         smallint NOT NULL CHECK (minute BETWEEN 0 AND 59),
  days_of_week   smallint[] NOT NULL CHECK (cardinality(days_of_week) BETWEEN 1 AND 7 AND days_of_week <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  timezone       text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  -- Hard ceiling: a routine can never be configured above tier 1.
  max_tier       smallint NOT NULL DEFAULT 0 CHECK (max_tier BETWEEN 0 AND 1),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  next_run_at    timestamptz,
  last_run_at    timestamptz,
  created_by     text NOT NULL,
  updated_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  CHECK (status = 'paused' OR next_run_at IS NOT NULL)
);
CREATE INDEX routines_due_idx ON routines (tenant_id, status, next_run_at);

-- One row per attempted run. The unique key makes a duplicate job a no-op.
CREATE TABLE routine_runs (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  routine_id       uuid NOT NULL,
  trigger          text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  scheduled_for    timestamptz NOT NULL,
  status           text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  skip_reason      text CHECK (skip_reason IN ('agents_paused', 'quota_exceeded', 'routine_paused')),
  -- [{source, rows, asOf}]: every table the run read, recorded even when it failed.
  sources          jsonb NOT NULL DEFAULT '[]',
  output           jsonb,
  error            text CHECK (length(error) <= 2000),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, routine_id, idempotency_key),
  FOREIGN KEY (tenant_id, routine_id) REFERENCES routines (tenant_id, id) ON DELETE CASCADE,
  CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
  CHECK (status <> 'failed' OR error IS NOT NULL),
  CHECK (status <> 'succeeded' OR output IS NOT NULL)
);
CREATE INDEX routine_runs_recent_idx ON routine_runs (tenant_id, routine_id, started_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['routines', 'routine_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t || '_tenant', t);
  END LOOP;
END $$;

-- No DELETE for the app: routines are paused, not removed; run history is kept.
GRANT SELECT, INSERT, UPDATE ON routines, routine_runs TO app_user;

-- Monthly routine-run allowance is metered like the other plan quotas.
ALTER TABLE usage_counters DROP CONSTRAINT IF EXISTS usage_counters_metric_check;
ALTER TABLE usage_counters ADD CONSTRAINT usage_counters_metric_check
  CHECK (metric IN ('tasks', 'scout.opportunities', 'scout.prospect_rows', 'ai_cost_micros', 'routine.runs'));
