-- 0024 (PROPOSED, NOT APPLIED): one managed phone number per workspace.
-- The app does not read this table yet. Number records live in memory_records
-- (scope_ref 'speed:managed-number') until this file is moved into migrations/
-- after review. Rollback: 0024_managed_numbers.down.sql
--
-- Why not memory_records long-term: the cross-tenant "who owns this phone"
-- check should be enforced by the database (partial unique index below), not
-- by application code alone.

CREATE TABLE managed_numbers (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone        text NOT NULL CHECK (phone ~ '^\+1[2-9]\d{9}$'),
  provider_sid text CHECK (provider_sid IS NULL OR length(provider_sid) BETWEEN 3 AND 64),
  status       text NOT NULL CHECK (status IN ('reserving', 'active', 'releasing', 'released')),
  a2p_status   text NOT NULL DEFAULT 'not_started' CHECK (a2p_status IN ('not_started', 'pending', 'approved', 'rejected')),
  mock         boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id)
);

-- One active number per workspace; one phone held by at most one workspace at a time.
CREATE UNIQUE INDEX managed_numbers_tenant_active ON managed_numbers (tenant_id) WHERE status IN ('reserving', 'active', 'releasing');
CREATE UNIQUE INDEX managed_numbers_phone_held ON managed_numbers (phone) WHERE status <> 'released';

-- Same tenant policy as migrations 0001–0019: the row's tenant_id must be the
-- transaction's app.tenant_id. FORCE so the table owner is not exempt.
ALTER TABLE managed_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_numbers FORCE ROW LEVEL SECURITY;
CREATE POLICY managed_numbers_tenant ON managed_numbers
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- No DELETE: a released number's record is kept (who paid for what, when).
GRANT SELECT, INSERT, UPDATE ON managed_numbers TO app_user;
