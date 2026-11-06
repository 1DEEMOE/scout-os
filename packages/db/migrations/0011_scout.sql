-- 0011: Scout lead intelligence (ADR-004 §4). Additive only.
-- Every table is a tenant table: forced RLS, composite FKs, minimal grants.
-- Scout stores observations and the customer's own prospect records. It never
-- stores inferred personal characteristics, and it has no cold-outreach path.

ALTER TABLE agents DROP CONSTRAINT agents_kind_check;
ALTER TABLE agents ADD CONSTRAINT agents_kind_check
  CHECK (kind IN ('orchestrator', 'inbox', 'sales', 'finance', 'scheduling', 'reporting', 'scout'));

-- One profile per org. Scout won't scan until a person has reviewed it.
CREATE TABLE business_profiles (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vertical        text NOT NULL CHECK (vertical IN ('roofing')),
  website         text CHECK (length(website) <= 300),
  services        text[] NOT NULL DEFAULT '{}',
  ideal_customer  text NOT NULL DEFAULT '' CHECK (length(ideal_customer) <= 2000),
  -- {states: ["TX"], counties: [{state, county}], center: {lat, lon} | null}
  service_area    jsonb NOT NULL DEFAULT '{"states": [], "counties": [], "center": null}',
  -- {radiusMiles, lookbackDays, minScore, retentionDays}
  settings        jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed')),
  reviewed_by     text,
  reviewed_at     timestamptz,
  updated_by      text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id),
  UNIQUE (tenant_id, id),
  CHECK ((status = 'reviewed') = (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

-- Where data came from, with the rights the customer declared for it.
CREATE TABLE intelligence_sources (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('noaa_spc_storm_reports', 'crm_contacts', 'customer_import')),
  label         text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  usage_rights  text NOT NULL CHECK (length(usage_rights) BETWEEN 1 AND 2000),
  attestation   text CHECK (length(attestation) <= 2000),
  attested_by   text,
  attested_at   timestamptz,
  row_count     integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  demo          boolean NOT NULL DEFAULT false,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  -- A customer list can only be imported with a recorded attestation of the right to use it.
  CHECK (kind <> 'customer_import' OR (attestation IS NOT NULL AND attested_by IS NOT NULL AND attested_at IS NOT NULL))
);

-- Observable events. No personal data.
CREATE TABLE signal_observations (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id       uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('hail', 'wind', 'tornado')),
  event_at        timestamptz NOT NULL,
  collected_at    timestamptz NOT NULL DEFAULT now(),
  location        text NOT NULL CHECK (length(location) <= 200),
  county          text NOT NULL CHECK (length(county) <= 100),
  state           text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  lat             double precision CHECK (lat BETWEEN -90 AND 90),
  lon             double precision CHECK (lon BETWEEN -180 AND 180),
  magnitude       numeric,
  magnitude_unit  text CHECK (magnitude_unit IN ('in', 'mph')),
  comments        text NOT NULL DEFAULT '' CHECK (length(comments) <= 2000),
  confidence      text NOT NULL,
  limitations     text NOT NULL,
  external_ref    text NOT NULL CHECK (length(external_ref) <= 200),
  demo            boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, external_ref),
  FOREIGN KEY (tenant_id, source_id) REFERENCES intelligence_sources (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX signal_observations_when_idx ON signal_observations (tenant_id, event_at DESC);
CREATE INDEX signal_observations_place_idx ON signal_observations (tenant_id, state, county);

-- A person or organization that may be relevant. Only allow-listed columns are stored.
CREATE TABLE prospects (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id        uuid NOT NULL,
  source_row       integer CHECK (source_row >= 1),
  contact_id       uuid,
  kind             text NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'organization')),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  email            text CHECK (length(email) <= 254),
  phone            text CHECK (length(phone) <= 40),
  address          text CHECK (length(address) <= 300),
  city             text CHECK (length(city) <= 100),
  county           text CHECK (length(county) <= 100),
  state            text CHECK (state ~ '^[A-Z]{2}$'),
  postal_code      text CHECK (length(postal_code) <= 20),
  lat              double precision CHECK (lat BETWEEN -90 AND 90),
  lon              double precision CHECK (lon BETWEEN -180 AND 180),
  dedupe_key       text NOT NULL CHECK (length(dedupe_key) <= 300),
  retention_until  timestamptz NOT NULL,
  demo             boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, source_id) REFERENCES intelligence_sources (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (contact_id),
  CHECK ((lat IS NULL) = (lon IS NULL))
);
CREATE INDEX prospects_retention_idx ON prospects (tenant_id, retention_until);

-- A prospect + the signals behind it + a heuristic score + a lifecycle stage.
CREATE TABLE opportunities (
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prospect_id          uuid NOT NULL,
  vertical             text NOT NULL CHECK (vertical IN ('roofing')),
  stage                text NOT NULL DEFAULT 'prospect' CHECK (stage IN ('prospect', 'engaged', 'qualified', 'opportunity', 'disqualified')),
  score                integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  score_breakdown      jsonb NOT NULL,
  explanation          jsonb NOT NULL,
  signal_ids           uuid[] NOT NULL CHECK (cardinality(signal_ids) >= 1),
  qualification        jsonb,
  disqualified_reason  text CHECK (length(disqualified_reason) <= 500),
  handoff_task_id      uuid,
  demo                 boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, prospect_id) REFERENCES prospects (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, handoff_task_id) REFERENCES tasks (tenant_id, id) ON DELETE SET NULL (handoff_task_id),
  CHECK ((stage = 'disqualified') = (disqualified_reason IS NOT NULL)),
  CHECK (stage NOT IN ('qualified', 'opportunity') OR qualification IS NOT NULL)
);
-- One open opportunity per prospect and vertical.
CREATE UNIQUE INDEX opportunities_open_idx ON opportunities (tenant_id, prospect_id, vertical) WHERE stage <> 'disqualified';
CREATE INDEX opportunities_feed_idx ON opportunities (tenant_id, stage, score DESC);

-- Append-only stage history with the evidence for each move.
CREATE TABLE opportunity_events (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id  uuid NOT NULL,
  from_stage      text,
  to_stage        text NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id        text NOT NULL,
  evidence        text NOT NULL CHECK (length(evidence) BETWEEN 1 AND 2000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX opportunity_events_opp_idx ON opportunity_events (tenant_id, opportunity_id, created_at);

-- Basis for contacting someone on a channel. Public contact info is not permission.
CREATE TABLE communication_permissions (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel      text NOT NULL CHECK (channel IN ('email')),
  value        text NOT NULL CHECK (value = lower(value) AND length(value) BETWEEN 3 AND 254),
  basis        text NOT NULL CHECK (basis IN ('existing_customer', 'inbound_inquiry', 'express_written_consent')),
  evidence     text NOT NULL CHECK (length(evidence) BETWEEN 1 AND 2000),
  recorded_by  text NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  revoked_by   text,
  revoked_at   timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX communication_permissions_active_idx ON communication_permissions (tenant_id, channel, value) WHERE revoked_at IS NULL;

-- Do-not-contact. Checked before any send. Never removed by the app.
CREATE TABLE suppression_list (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('email')),
  value       text NOT NULL CHECK (value = lower(value) AND length(value) BETWEEN 3 AND 254),
  reason      text NOT NULL CHECK (reason IN ('opt_out', 'bounce', 'complaint', 'manual')),
  added_by    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel, value)
);

-- Follow-up drafts, sends and blocks, linked to the opportunity.
CREATE TABLE outreach_events (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id  uuid,
  channel         text NOT NULL CHECK (channel IN ('email')),
  recipient       text NOT NULL CHECK (length(recipient) <= 254),
  kind            text NOT NULL CHECK (kind IN ('sent', 'blocked')),
  reason          text CHECK (length(reason) <= 500),
  actor_type      text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id        text NOT NULL,
  ref             text CHECK (length(ref) <= 300),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, id) ON DELETE SET NULL (opportunity_id),
  CHECK ((kind = 'blocked') = (reason IS NOT NULL))
);
CREATE INDEX outreach_events_opp_idx ON outreach_events (tenant_id, opportunity_id, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['business_profiles', 'intelligence_sources', 'signal_observations', 'prospects', 'opportunities',
                           'opportunity_events', 'communication_permissions', 'suppression_list', 'outreach_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON business_profiles, opportunities TO app_user;
GRANT SELECT, INSERT, UPDATE ON intelligence_sources TO app_user;          -- row_count update after import
GRANT SELECT, INSERT ON signal_observations, opportunity_events, suppression_list, outreach_events TO app_user;
GRANT SELECT, INSERT, UPDATE ON communication_permissions TO app_user;     -- revoke = update
GRANT SELECT, INSERT, DELETE ON prospects TO app_user;                     -- DELETE only for the retention purge
