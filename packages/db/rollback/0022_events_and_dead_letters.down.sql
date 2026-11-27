-- Rollback for 0022. 
DROP INDEX IF EXISTS audit_events_tenant_action_idx;
DROP TABLE IF EXISTS integration_breakers;
DROP TABLE IF EXISTS dead_letters;
DROP TABLE IF EXISTS integration_events;
DELETE FROM schema_migrations WHERE name = '0022_events_and_dead_letters.sql';
