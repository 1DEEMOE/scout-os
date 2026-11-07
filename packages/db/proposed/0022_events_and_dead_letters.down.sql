-- Rollback for proposed 0022. Not applied by the migrator.

DROP INDEX IF EXISTS audit_events_tenant_action_idx;
DROP TABLE IF EXISTS integration_breakers;
DROP TABLE IF EXISTS dead_letters;
DROP TABLE IF EXISTS integration_events;
