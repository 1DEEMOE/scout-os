-- Rollback for 0028. Revert the application code first: with this applied the
-- event bus can no longer claim events (it needs the lease columns).
--
-- Data note: rows in 'in_progress' or 'failed' only exist while an effect is
-- running or waiting for a retry; they are removed because the old status check
-- cannot hold them. Completed rows ('done', 'skipped', 'dead') are untouched.
SET LOCAL lock_timeout = '5s';

DELETE FROM integration_events WHERE status IN ('in_progress', 'failed');

REVOKE UPDATE (status, lease_owner, lease_expires_at, attempts) ON integration_events FROM app_user;
ALTER TABLE integration_events DROP CONSTRAINT integration_events_lease_state_check;
ALTER TABLE integration_events DROP COLUMN lease_owner, DROP COLUMN lease_expires_at, DROP COLUMN attempts;
ALTER TABLE integration_events DROP CONSTRAINT integration_events_status_check;
ALTER TABLE integration_events ADD CONSTRAINT integration_events_status_check CHECK (status IN ('done', 'skipped', 'dead'));

-- Restores the 0021 definitions, including their defect (deleting a referenced
-- service or resource fails because the action tries to null tenant_id).
ALTER TABLE appointments DROP CONSTRAINT appointments_tenant_id_resource_id_fkey;
ALTER TABLE appointments ADD CONSTRAINT appointments_tenant_id_resource_id_fkey
  FOREIGN KEY (tenant_id, resource_id) REFERENCES bookable_resources (tenant_id, id) ON DELETE SET NULL;
ALTER TABLE appointments DROP CONSTRAINT appointments_tenant_id_service_id_fkey;
ALTER TABLE appointments ADD CONSTRAINT appointments_tenant_id_service_id_fkey
  FOREIGN KEY (tenant_id, service_id) REFERENCES service_menu_items (tenant_id, id) ON DELETE SET NULL;

DELETE FROM schema_migrations WHERE name = '0028_data_fixes_0020_0023.sql';
