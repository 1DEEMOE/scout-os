-- Reverses 0010. Run as wos_owner after a backup. Quota history is lost; nothing else changes.
BEGIN;
DROP TABLE IF EXISTS usage_counters;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS last_event_at;
DELETE FROM schema_migrations WHERE name = '0010_entitlements.sql';
COMMIT;
