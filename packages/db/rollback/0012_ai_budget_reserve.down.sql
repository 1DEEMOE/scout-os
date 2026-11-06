-- Rolls back 0012. Deletes ai_cost_micros counter rows first.
BEGIN;
DELETE FROM usage_counters WHERE metric = 'ai_cost_micros';
ALTER TABLE usage_counters DROP CONSTRAINT IF EXISTS usage_counters_metric_check;
ALTER TABLE usage_counters ADD CONSTRAINT usage_counters_metric_check
  CHECK (metric IN ('tasks', 'scout.opportunities', 'scout.prospect_rows'));
REVOKE DELETE ON webhook_events FROM app_user;
DELETE FROM schema_migrations WHERE name = '0012_ai_budget_reserve.sql';
COMMIT;
