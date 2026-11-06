-- 0017: gaps-2 — AI front desk, AI answers checks, tamper-proof job photos,
-- forged estimate/invoice detection.
-- Rollback: packages/db/rollback/0017_gaps2_front_desk_photos_docs.down.sql
--
-- Approvals are NEVER loosened: outside bookings always need tier ≥2;
-- document risk flags raise Approvals and never auto-pay.

-- Public booking channel per org (token is the URL key; rotate by replacing).
CREATE TABLE front_desk_channels (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  public_token    text NOT NULL CHECK (length(public_token) BETWEEN 16 AND 64),
  display_name    text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  timezone        text NOT NULL DEFAULT 'America/New_York' CHECK (length(timezone) BETWEEN 1 AND 64),
  disclosure      text NOT NULL DEFAULT 'Bookings are reviewed by a person before they are confirmed.'
    CHECK (length(disclosure) BETWEEN 1 AND 500),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (public_token)
);
CREATE INDEX front_desk_channels_tenant_idx ON front_desk_channels (tenant_id);

CREATE TABLE front_desk_slots (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  capacity        smallint NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 50),
  reserved_count  smallint NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES front_desk_channels (tenant_id, id) ON DELETE CASCADE,
  CHECK (ends_at > starts_at),
  CHECK (reserved_count <= capacity)
);
CREATE INDEX front_desk_slots_open_idx ON front_desk_slots (tenant_id, channel_id, starts_at);

CREATE TABLE front_desk_bookings (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_id          uuid NOT NULL,
  slot_id             uuid NOT NULL,
  -- Who is asking: person or AI agent. Always disclosed.
  requester_kind      text NOT NULL CHECK (requester_kind IN ('person', 'ai_agent')),
  agent_name          text CHECK (agent_name IS NULL OR length(agent_name) BETWEEN 1 AND 120),
  agent_provider      text CHECK (agent_provider IS NULL OR length(agent_provider) BETWEEN 1 AND 120),
  disclosure_ack      boolean NOT NULL,
  customer_name       text NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 120),
  customer_email      text NOT NULL CHECK (length(customer_email) BETWEEN 3 AND 200),
  customer_phone      text CHECK (customer_phone IS NULL OR length(customer_phone) BETWEEN 7 AND 40),
  notes               text CHECK (notes IS NULL OR length(notes) <= 1000),
  client_ref          text CHECK (client_ref IS NULL OR length(client_ref) BETWEEN 1 AND 100),
  source_ip_hash      text NOT NULL, -- sha256 of IP + daily salt; never raw IP
  status              text NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval', 'confirmed', 'rejected', 'cancelled', 'blocked')),
  approval_request_id uuid,
  task_id             uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES front_desk_channels (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, slot_id) REFERENCES front_desk_slots (tenant_id, id) ON DELETE CASCADE,
  CHECK (
    (requester_kind = 'person' AND agent_name IS NULL AND agent_provider IS NULL)
    OR (requester_kind = 'ai_agent' AND agent_name IS NOT NULL)
  ),
  CHECK (disclosure_ack = true),
  UNIQUE (tenant_id, channel_id, client_ref)
);
CREATE INDEX front_desk_bookings_open_idx
  ON front_desk_bookings (tenant_id, status, created_at DESC)
  WHERE status = 'pending_approval';

-- Per-channel rate / abuse buckets (windowed counters). key has no PII.
CREATE TABLE front_desk_rate_buckets (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL,
  bucket_key   text NOT NULL CHECK (length(bucket_key) BETWEEN 1 AND 200),
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, channel_id, bucket_key, window_start),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES front_desk_channels (tenant_id, id) ON DELETE CASCADE
);

-- Monthly AI-answer visibility checks (mock provider in tests; no live calls).
CREATE TABLE ai_answer_checks (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period          text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  trade           text NOT NULL CHECK (length(trade) BETWEEN 1 AND 80),
  zip             text NOT NULL CHECK (zip ~ '^[0-9]{5}$'),
  recommended     boolean NOT NULL,
  score           smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  provider        text NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
  suggestions     jsonb NOT NULL DEFAULT '[]',
  trend_delta     smallint,
  routine_run_id  uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, period, trade, zip)
);

-- Tamper-evident job photos: hash chain per job (task).
CREATE TABLE job_photos (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id           uuid NOT NULL, -- tasks.id
  sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  prev_sha256      text CHECK (prev_sha256 IS NULL OR prev_sha256 ~ '^[0-9a-f]{64}$'),
  chain_index      integer NOT NULL CHECK (chain_index >= 0),
  capture_at       timestamptz NOT NULL,
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  uploader_user_id text NOT NULL,
  gps_lat          double precision CHECK (gps_lat IS NULL OR (gps_lat BETWEEN -90 AND 90)),
  gps_lng          double precision CHECK (gps_lng IS NULL OR (gps_lng BETWEEN -180 AND 180)),
  filename         text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
  content_type     text NOT NULL CHECK (length(content_type) BETWEEN 3 AND 100),
  byte_length      integer NOT NULL CHECK (byte_length > 0 AND byte_length <= 20971520),
  storage_ref      text NOT NULL, -- local path or object key; not a public URL
  -- Flags set when a re-upload or edit is detected against the chain / prior hashes.
  integrity_status text NOT NULL DEFAULT 'ok'
    CHECK (integrity_status IN ('ok', 'edited', 'reuploaded', 'broken_chain')),
  integrity_note   text CHECK (integrity_note IS NULL OR length(integrity_note) <= 500),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, job_id, chain_index),
  UNIQUE (tenant_id, job_id, sha256),
  FOREIGN KEY (tenant_id, job_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  CHECK ((gps_lat IS NULL) = (gps_lng IS NULL))
);
CREATE INDEX job_photos_job_idx ON job_photos (tenant_id, job_id, chain_index);

-- Incoming vendor invoices / estimates with forgery risk flags. Never auto-pay.
CREATE TABLE incoming_documents (
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('invoice', 'estimate')),
  vendor_name          text NOT NULL CHECK (length(vendor_name) BETWEEN 1 AND 200),
  vendor_email         text CHECK (vendor_email IS NULL OR length(vendor_email) BETWEEN 3 AND 200),
  document_number      text CHECK (document_number IS NULL OR length(document_number) BETWEEN 1 AND 80),
  amount_cents         bigint NOT NULL CHECK (amount_cents >= 0),
  currency             text NOT NULL DEFAULT 'usd' CHECK (length(currency) BETWEEN 3 AND 8),
  sender_domain        text CHECK (sender_domain IS NULL OR length(sender_domain) BETWEEN 1 AND 200),
  expected_domain      text CHECK (expected_domain IS NULL OR length(expected_domain) BETWEEN 1 AND 200),
  account_last4        text CHECK (account_last4 IS NULL OR account_last4 ~ '^[0-9]{4}$'),
  destination_id       uuid,
  pdf_metadata         jsonb NOT NULL DEFAULT '{}',
  risk_flags           jsonb NOT NULL DEFAULT '[]',
  risk_score           smallint NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  status               text NOT NULL DEFAULT 'flagged'
    CHECK (status IN ('flagged', 'cleared', 'rejected', 'paid_elsewhere')),
  approval_request_id  uuid,
  task_id              uuid,
  created_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, destination_id) REFERENCES payment_destinations (tenant_id, id) ON DELETE SET NULL
);
CREATE INDEX incoming_documents_open_idx
  ON incoming_documents (tenant_id, status, created_at DESC)
  WHERE status = 'flagged';
CREATE INDEX incoming_documents_number_idx
  ON incoming_documents (tenant_id, kind, document_number)
  WHERE document_number IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'front_desk_channels', 'front_desk_slots', 'front_desk_bookings', 'front_desk_rate_buckets',
    'ai_answer_checks', 'job_photos', 'incoming_documents'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t || '_tenant', t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON
  front_desk_channels, front_desk_slots, front_desk_bookings, front_desk_rate_buckets,
  ai_answer_checks, job_photos, incoming_documents TO app_user;
-- No DELETE from the app for evidence / booking history.
