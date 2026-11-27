-- Rollback for 0022 (run 0028's and 0029's rollbacks first; scripts/test-rollbacks.mjs does).
-- DESTRUCTIVE: drops integration_events, dead_letters and integration_breakers with their rows.
-- Before running: (1) deploy code that no longer uses the durable bus (WOS_DURABLE_EVENTS=0 or an
-- older build), otherwise the app will error on the missing tables; (2) export the tables if you
-- want the history (the dead_letters in particular).
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE IF EXISTS integration_breakers;
DROP TABLE IF EXISTS dead_letters;
DROP TABLE IF EXISTS integration_events;
DELETE FROM schema_migrations WHERE name = '0022_events_and_dead_letters.sql';
COMMIT;
