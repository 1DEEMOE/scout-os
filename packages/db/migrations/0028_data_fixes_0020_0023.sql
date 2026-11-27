-- 0028: data fixes found in the review of migrations 0020-0023.
--
-- STATUS: written for owner review. Not applied to any staging or production
-- database. 0020-0023 are left exactly as adopted; these are forward changes.
--
--   Fix 1  appointments: the composite foreign keys used `ON DELETE SET NULL`
--          without a column list, so deleting a service or resource tried to null
--          tenant_id (NOT NULL) and failed. Use the column-list form already used
--          in 0003/0004/0005/0011: ON DELETE SET NULL (service_id).
--   Fix 3  integration_events becomes a claim table so a provider effect cannot
--          run twice at the same time in two processes: add the 'in_progress' and
--          'failed' statuses, a lease (owner + expiry) and an attempt counter, and
--          let app_user update ONLY those lease columns (still no change to type,
--          source, key or tenant, and still no DELETE).
--
-- Locks: appointments and the two parent tables are small (new in 0021). The
-- timeouts make a blocked ALTER fail fast instead of queueing behind traffic.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Fix 1 ----------------------------------------------------------------------
ALTER TABLE appointments DROP CONSTRAINT appointments_tenant_id_service_id_fkey;
ALTER TABLE appointments ADD CONSTRAINT appointments_tenant_id_service_id_fkey
  FOREIGN KEY (tenant_id, service_id) REFERENCES service_menu_items (tenant_id, id) ON DELETE SET NULL (service_id);

ALTER TABLE appointments DROP CONSTRAINT appointments_tenant_id_resource_id_fkey;
ALTER TABLE appointments ADD CONSTRAINT appointments_tenant_id_resource_id_fkey
  FOREIGN KEY (tenant_id, resource_id) REFERENCES bookable_resources (tenant_id, id) ON DELETE SET NULL (resource_id);

-- Fix 3 ----------------------------------------------------------------------
-- 'in_progress': a worker holds the lease and is running the effect.
-- 'failed':      the attempt ended without a result; the key can be claimed again.
-- 'done' / 'skipped' / 'dead' keep their meaning from 0022.
ALTER TABLE integration_events DROP CONSTRAINT integration_events_status_check;
ALTER TABLE integration_events ADD CONSTRAINT integration_events_status_check
  CHECK (status IN ('done', 'skipped', 'dead', 'in_progress', 'failed'));

ALTER TABLE integration_events
  ADD COLUMN lease_owner       text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 80),
  ADD COLUMN lease_expires_at  timestamptz,
  ADD COLUMN attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0);

-- A lease exists exactly while the event is in progress.
ALTER TABLE integration_events ADD CONSTRAINT integration_events_lease_state_check CHECK (
  (status = 'in_progress' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  OR (status <> 'in_progress' AND lease_owner IS NULL AND lease_expires_at IS NULL)
);

-- Column-level: the app can move an event through its lifecycle but cannot
-- rewrite what the event was (tenant_id, idempotency_key, type, source stay
-- append-only). Row-level security still confines every statement to the tenant.
GRANT UPDATE (status, lease_owner, lease_expires_at, attempts) ON integration_events TO app_user;
