-- 0004: contacts and CRM records (Milestone 4).

CREATE TABLE contacts (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         text NOT NULL DEFAULT '',
  email        text,
  phone        text,
  company      text,
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'inbox', 'crm_sync', 'agent')),
  external_id  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX contacts_tenant_email_idx ON contacts (tenant_id, lower(email)) WHERE email IS NOT NULL;

CREATE TABLE crm_records (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  contact_id    uuid,
  provider      text NOT NULL CHECK (provider IN ('hubspot', 'fake')),
  kind          text NOT NULL DEFAULT 'deal' CHECK (kind IN ('deal')),
  external_id   text NOT NULL,
  name          text NOT NULL,
  stage         text NOT NULL,
  amount_cents  bigint CHECK (amount_cents IS NULL OR amount_cents >= 0),
  synced_at     timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, external_id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (contact_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts', 'crm_records'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
                   t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON contacts, crm_records TO app_user;
