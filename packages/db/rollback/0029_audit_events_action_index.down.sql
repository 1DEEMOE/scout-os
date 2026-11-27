-- Rollback for 0029. Dropping an index takes a brief lock on audit_events; run it off-peak.
DROP INDEX IF EXISTS audit_events_tenant_action_idx;
DELETE FROM schema_migrations WHERE name = '0029_audit_events_action_index.sql';
