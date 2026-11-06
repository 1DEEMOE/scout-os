-- 0012: AI budget reservation counter + webhook claim release (Phase 9 correctness).
-- Rollback: packages/db/rollback/0012_ai_budget_reserve.down.sql

-- Track reserved/settled AI spend atomically (same pattern as plan quotas).
ALTER TABLE usage_counters DROP CONSTRAINT IF EXISTS usage_counters_metric_check;
ALTER TABLE usage_counters ADD CONSTRAINT usage_counters_metric_check
  CHECK (metric IN ('tasks', 'scout.opportunities', 'scout.prospect_rows', 'ai_cost_micros'));

-- So a failed webhook apply can release its claim and Stripe can retry.
GRANT DELETE ON webhook_events TO app_user;
