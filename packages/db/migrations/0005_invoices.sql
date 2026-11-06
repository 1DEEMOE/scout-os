-- 0005: invoices (Milestone 5). Money is integer cents, never floating point.

CREATE TABLE invoices (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id        uuid,
  provider          text NOT NULL CHECK (provider IN ('stripe', 'fake')),
  external_id       text NOT NULL,
  number            text,
  customer_email    text,
  customer_name     text,
  status            text NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  amount_due_cents  bigint NOT NULL CHECK (amount_due_cents >= 0),
  currency          text NOT NULL DEFAULT 'usd' CHECK (currency ~ '^[a-z]{3}$'),
  due_date          date,
  hosted_url        text,
  last_reminder_at  timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, external_id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (contact_id)
);
CREATE INDEX invoices_tenant_status_due_idx ON invoices (tenant_id, status, due_date);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY invoices_tenant ON invoices USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON invoices TO app_user;
