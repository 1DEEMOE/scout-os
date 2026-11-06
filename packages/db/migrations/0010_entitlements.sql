-- 0010: quota counters for plan entitlements (ADR-004 §3). Additive.
-- Rollback: packages/db/rollback/0010_entitlements.down.sql

CREATE TABLE usage_counters (
  tenant_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric      text NOT NULL CHECK (metric IN ('tasks', 'scout.opportunities', 'scout.prospect_rows')),
  period      text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  used        bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric, period)
);

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_counters_tenant ON usage_counters USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
-- No DELETE: the app can't reset its own usage.
GRANT SELECT, INSERT, UPDATE ON usage_counters TO app_user;

-- Stripe may deliver events late or out of order. Only an event at least as new as the
-- last one applied may change a subscription (and so the plan).
ALTER TABLE subscriptions ADD COLUMN last_event_at timestamptz;
