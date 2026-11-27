-- 0026 (PROPOSED, NOT APPLIED): vertical jobs workspace (intake → estimate →
-- dispatch). The app does not read this table yet. Job records live in
-- memory_records (scope_ref 'job:<id>') until this file is moved into
-- migrations/ after review. Rollback: 0026_jobs.down.sql
--
-- Why not memory_records long-term: the 2000-char content cap forces estimates
-- to be recomputed instead of snapshotted, and listing all jobs for a tenant
-- is a LIKE scan. A real table gets a snapshot column, proper indexes on
-- status/schedule, and CHECK-constrained status transitions data.

CREATE TABLE jobs (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pack_id        text NOT NULL CHECK (pack_id ~ '^[a-z0-9_]+$'),
  customer_name  text NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 120),
  customer_email text CHECK (customer_email IS NULL OR length(customer_email) <= 200),
  customer_phone text CHECK (customer_phone IS NULL OR length(customer_phone) <= 40),
  answers        jsonb NOT NULL DEFAULT '{}',
  jurisdiction   text NOT NULL DEFAULT 'intrastate' CHECK (jurisdiction IN ('intrastate', 'interstate')),
  status         text NOT NULL DEFAULT 'inquiry' CHECK (status IN ('inquiry', 'estimate_ready', 'approval_pending', 'estimate_sent', 'booked', 'dispatched', 'in_progress', 'done', 'cancelled', 'lost')),
  crew           jsonb NOT NULL DEFAULT '[]',
  scheduled_for  timestamptz,
  -- Snapshot of the estimate at send time; live estimates are recomputed from answers.
  sent_estimate  jsonb,
  sent_at        timestamptz,
  created_by     text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id)
);

CREATE INDEX jobs_tenant_status ON jobs (tenant_id, status);
CREATE INDEX jobs_tenant_scheduled ON jobs (tenant_id, scheduled_for) WHERE scheduled_for IS NOT NULL;

-- Per-org pricing/business config that unlocks sending (owner-confirmed
-- prices, pack-required business fields like a USDOT number).
CREATE TABLE jobs_config (
  tenant_id                uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  owner_configured_prices  boolean NOT NULL DEFAULT false,
  overrides                jsonb NOT NULL DEFAULT '{}',
  business_fields          jsonb NOT NULL DEFAULT '{}',
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Same tenant policy as migrations 0001–0019: the row's tenant_id must be the
-- transaction's app.tenant_id. FORCE so the table owner is not exempt.
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY jobs_tenant ON jobs
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE jobs_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs_config FORCE ROW LEVEL SECURITY;
CREATE POLICY jobs_config_tenant ON jobs_config
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- No DELETE on jobs: a job is a financial record (estimate sent, money
-- discussed); cancel/lost are statuses, not deletions.
GRANT SELECT, INSERT, UPDATE ON jobs TO app_user;
GRANT SELECT, INSERT, UPDATE ON jobs_config TO app_user;
