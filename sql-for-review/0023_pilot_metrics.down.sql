-- Rollback for 0023. DESTRUCTIVE: drops pilot_metrics and its rows (the app falls back to
-- memory_records pilot:metrics). Export first if you want the numbers.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE IF EXISTS pilot_metrics;
DELETE FROM schema_migrations WHERE name = '0023_pilot_metrics.sql';
COMMIT;
