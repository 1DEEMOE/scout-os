-- 0027 (PROPOSED, NOT APPLIED): native CRM pipeline, contact notes, pipeline
-- weights, and the public lead-capture form. The app does not read these
-- tables yet. Deals live in memory_records (scope_ref 'deal:<id>'), notes at
-- 'note:<contactId>:<noteId>', and both configs as single org-scope rows until
-- this file is moved into migrations/ after review. Rollback:
-- 0027_crm_pipeline.down.sql
--
-- Why not memory_records long-term: the board query is a LIKE scan over every
-- org row, the 2000-char cap bounds note bodies, and cross-tenant safety rests
-- on app code remembering the tenant predicate. Real tables get proper
-- indexes, CHECK-constrained stages/sources, and RLS enforced by the database.

CREATE TABLE deals (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id     uuid,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  amount_cents   bigint CHECK (amount_cents IS NULL OR (amount_cents >= 0 AND amount_cents <= 10000000000)),
  stage          text NOT NULL DEFAULT 'lead' CHECK (stage IN ('lead', 'qualified', 'quote_sent', 'negotiation', 'won', 'lost')),
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'web_form', 'inbox', 'job', 'import')),
  expected_close date,
  owner_user_id  text,
  lost_reason    text CHECK (lost_reason IS NULL OR length(lost_reason) <= 200),
  created_by     text NOT NULL,
  closed_at      timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  -- Contact removal detaches the deal instead of deleting it (financial-adjacent
  -- record). Column-listed SET NULL keeps tenant_id intact (PG 15+).
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (contact_id)
);

CREATE INDEX deals_tenant_stage ON deals (tenant_id, stage);
CREATE INDEX deals_tenant_contact ON deals (tenant_id, contact_id) WHERE contact_id IS NOT NULL;

-- Per-org open-stage win probabilities in basis points (0–10000 = 0–100%).
-- Won/lost are facts (10000/0) and are not configurable.
CREATE TABLE pipeline_configs (
  tenant_id       uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  probability_bps jsonb NOT NULL DEFAULT '{}',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Append-only: no UPDATE or DELETE grant below, so a note is a permanent
-- record of who knew what when (matches how the timeline is displayed).
CREATE TABLE contact_notes (
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX contact_notes_tenant_contact ON contact_notes (tenant_id, contact_id, created_at DESC);

-- One lead form per front-desk channel (the form shares the channel's public
-- token: one public capability to guard, and pausing the desk closes the form).
CREATE TABLE lead_forms (
  channel_id      uuid PRIMARY KEY REFERENCES front_desk_channels(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT false,
  intro           text NOT NULL DEFAULT '' CHECK (length(intro) <= 300),
  success_message text NOT NULL DEFAULT 'Thanks — we''ll be in touch shortly.' CHECK (length(success_message) <= 300),
  ask_phone       boolean NOT NULL DEFAULT true,
  ask_company     boolean NOT NULL DEFAULT true,
  ask_message     boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Web-form leads get their own contact source.
ALTER TABLE contacts DROP CONSTRAINT contacts_source_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_source_check
  CHECK (source IN ('manual', 'inbox', 'crm_sync', 'agent', 'web_form'));

-- Same tenant policy as migrations 0001–0019: the row's tenant_id must be the
-- transaction's app.tenant_id. FORCE so the table owner is not exempt.
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals FORCE ROW LEVEL SECURITY;
CREATE POLICY deals_tenant ON deals
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE pipeline_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY pipeline_configs_tenant ON pipeline_configs
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE contact_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_notes_tenant ON contact_notes
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE lead_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_forms FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_forms_tenant ON lead_forms
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- No DELETE on deals (a deal is a financial-adjacent record; won/lost are
-- statuses, not deletions). No UPDATE/DELETE on contact_notes (append-only).
GRANT SELECT, INSERT, UPDATE ON deals TO app_user;
GRANT SELECT, INSERT, UPDATE ON pipeline_configs TO app_user;
GRANT SELECT, INSERT ON contact_notes TO app_user;
GRANT SELECT, INSERT, UPDATE ON lead_forms TO app_user;
