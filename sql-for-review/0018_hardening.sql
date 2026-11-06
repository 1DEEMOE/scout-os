-- 0018: Wave 1 trust + correctness hardening (audit 2026-11-06, items C2/C3/C4/H1).
-- Additive except front_desk_channels.public_token, which is replaced by its
-- SHA-256 hash. Rollback: packages/db/rollback/0018_hardening.down.sql

-- ---------- Pending invitations for people without an account ----------
-- The raw token is never stored; only its SHA-256. One pending invite per
-- (org, email) at a time. Accepting requires the signed-in user's email to
-- match the invited address.
CREATE TABLE organization_invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  token_hash  text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by  text NOT NULL,
  accepted_by text,
  accepted_at timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX organization_invitations_pending_idx
  ON organization_invitations (tenant_id, lower(email)) WHERE status = 'pending';
CREATE INDEX organization_invitations_token_idx ON organization_invitations (token_hash) WHERE status = 'pending';

ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_invitations_tenant ON organization_invitations
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON organization_invitations TO app_user;

-- ---------- Tamper-evident audit chain (weakness C4) ----------
-- Each new entry carries the SHA-256 of the previous entry and its own hash.
-- NULL on rows written before this migration: they are pre-chain history.
-- app_user has no UPDATE/DELETE on audit_events, so the chain can only grow.
ALTER TABLE audit_events ADD COLUMN prev_hash text;
ALTER TABLE audit_events ADD COLUMN entry_hash text;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_hash_shape
  CHECK ((prev_hash IS NULL OR prev_hash ~ '^[0-9a-f]{64}$') AND (entry_hash IS NULL OR entry_hash ~ '^[0-9a-f]{64}$'));

-- disconnectIntegration removes a connection and its mailboxes (audit trail in
-- audit_events; conversations keep their history via ON DELETE SET NULL).
GRANT DELETE ON integration_connections TO app_user;
GRANT DELETE ON email_identities TO app_user;

-- ---------- Front-desk bearer tokens: store hashes, not secrets (C2) ----------
-- A channel's public_token is a bearer credential to a public booking
-- endpoint; storing it in plaintext made a database read equal to full
-- booking access. Only the SHA-256 is kept. The embedded Postgres build lacks
-- pgcrypto, so the one-time backfill uses the built-in md5 twice (one-way for
-- these high-entropy random tokens); tokens created after this migration are
-- hashed app-side with SHA-256.
ALTER TABLE front_desk_channels ADD COLUMN token_hash text;
-- FORCE RLS hides existing rows from the migrating owner, so the backfill
-- must briefly disable RLS (owner-only migration connection; app unaffected).
ALTER TABLE front_desk_channels DISABLE ROW LEVEL SECURITY;
UPDATE front_desk_channels SET token_hash = md5(public_token) || md5(public_token || ':2');
ALTER TABLE front_desk_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE front_desk_channels ALTER COLUMN token_hash SET NOT NULL;
ALTER TABLE front_desk_channels ADD CONSTRAINT front_desk_channels_token_hash_shape
  CHECK (token_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE front_desk_channels DROP COLUMN public_token;
CREATE UNIQUE INDEX front_desk_channels_token_hash_idx ON front_desk_channels (token_hash);

-- ---------- Job photos: app may only flag integrity, never rewrite rows (H6) ----------
REVOKE UPDATE ON job_photos FROM app_user;
GRANT UPDATE (integrity_status, integrity_note) ON job_photos TO app_user;
