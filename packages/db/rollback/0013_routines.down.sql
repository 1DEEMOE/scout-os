-- Rolls back 0013. Drops routines and their run history: take a backup first
-- (pg_dump -t routines -t routine_runs) per Law 7.
BEGIN;
DROP TABLE IF EXISTS routine_runs, routines;
DELETE FROM usage_counters WHERE metric = 'routine.runs';
ALTER TABLE usage_counters DROP CONSTRAINT IF EXISTS usage_counters_metric_check;
ALTER TABLE usage_counters ADD CONSTRAINT usage_counters_metric_check
  CHECK (metric IN ('tasks', 'scout.opportunities', 'scout.prospect_rows', 'ai_cost_micros'));
DELETE FROM schema_migrations WHERE name = '0013_routines.sql';
COMMIT;
