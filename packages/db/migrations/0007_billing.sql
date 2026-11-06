-- 0007: usage metering, budgets, subscriptions and the billing ledger (Milestone 8).
-- Money is integer: cents for prices, micro-dollars (1e-6 USD) for usage costs.

ALTER TABLE organizations ADD COLUMN monthly_ai_budget_micros bigint NOT NULL DEFAULT 5000000
  CHECK (monthly_ai_budget_micros >= 0);

CREATE TABLE subscriptions (
  id                       uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_customer_id       text NOT NULL,
  stripe_subscription_id   text NOT NULL,
  status                   text NOT NULL,
  price_id                 text,
  current_period_end       timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, stripe_subscription_id)
);

CREATE TABLE usage_events (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id         uuid,
  task_id          uuid,
  kind             text NOT NULL CHECK (kind IN ('model_tokens', 'tool_call')),
  quantity         bigint NOT NULL CHECK (quantity >= 0),
  cost_micros      bigint NOT NULL CHECK (cost_micros >= 0),
  provider         text,
  model            text,
  purpose          text,
  idempotency_key  text,
  at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE INDEX usage_events_tenant_at_idx ON usage_events (tenant_id, at);
CREATE UNIQUE INDEX usage_events_idem_idx ON usage_events (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE billing_ledger (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entry_type     text NOT NULL CHECK (entry_type IN ('subscription_payment', 'usage', 'credit', 'refund')),
  amount_micros  bigint NOT NULL,
  period         text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  stripe_ref     text,
  at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
-- One usage entry per month; one entry per Stripe object.
CREATE UNIQUE INDEX billing_ledger_usage_period_idx ON billing_ledger (tenant_id, period) WHERE entry_type = 'usage';
CREATE UNIQUE INDEX billing_ledger_stripe_ref_idx ON billing_ledger (tenant_id, stripe_ref) WHERE stripe_ref IS NOT NULL;

-- Webhook replay protection. Global (events arrive before we know the tenant);
-- holds only provider event ids, no tenant data.
CREATE TABLE webhook_events (
  provider     text NOT NULL,
  event_id     text NOT NULL,
  event_type   text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions', 'usage_events', 'billing_ledger'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
                   t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON subscriptions TO app_user;
GRANT SELECT, INSERT ON usage_events, billing_ledger, webhook_events TO app_user;
