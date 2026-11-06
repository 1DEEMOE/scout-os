-- 0001: identity, organizations, membership, audit log, with row-level security.
-- Runs as wos_owner. The app connects as app_user, which neither owns these
-- tables nor has BYPASSRLS, so every policy below applies to it.

-- Tenant and user context. Unset or empty settings return NULL, which matches
-- no rows (fail closed).
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app_current_user() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;

-- ---------- Global identity tables (managed by the auth library) ----------
CREATE TABLE users (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  email          text NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  image          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE auth_sessions (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  ip_address  text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);

CREATE TABLE auth_accounts (
  id                        text PRIMARY KEY,
  user_id                   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id                text NOT NULL,
  provider_id               text NOT NULL,
  access_token              text,
  refresh_token             text,
  id_token                  text,
  access_token_expires_at   timestamptz,
  refresh_token_expires_at  timestamptz,
  scope                     text,
  password                  text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_accounts_user_idx ON auth_accounts (user_id);

CREATE TABLE auth_verifications (
  id          text PRIMARY KEY,
  identifier  text NOT NULL,
  value       text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Tenant tables ----------
CREATE TABLE organizations (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  plan        text NOT NULL DEFAULT 'free',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
  tenant_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX organization_members_user_idx ON organization_members (user_id);

CREATE TABLE audit_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_type           text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id             text NOT NULL,
  action               text NOT NULL,
  target               text,
  tier                 smallint NOT NULL DEFAULT 1 CHECK (tier BETWEEN 0 AND 4),
  approval_request_id  uuid,
  idempotency_key      text,
  outcome              text NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_tenant_at_idx ON audit_events (tenant_id, at DESC);
CREATE UNIQUE INDEX audit_events_idem_idx ON audit_events (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------- Row-level security ----------
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

-- Members: rows of the current tenant. A user context (no tenant) may read
-- only that user's own membership rows, which is how "my organizations" works.
CREATE POLICY members_tenant ON organization_members
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY members_self_read ON organization_members FOR SELECT
  USING (app_current_tenant() IS NULL AND user_id = app_current_user());

CREATE POLICY orgs_tenant ON organizations
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());
CREATE POLICY orgs_self_read ON organizations FOR SELECT
  USING (app_current_tenant() IS NULL AND id IN (
    SELECT tenant_id FROM organization_members WHERE user_id = app_current_user()));

-- Audit log is append-only: no UPDATE or DELETE policy, and no grant either.
CREATE POLICY audit_read ON audit_events FOR SELECT
  USING (tenant_id = app_current_tenant());
CREATE POLICY audit_insert ON audit_events FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant());

-- ---------- Grants for the app role ----------
GRANT USAGE ON SCHEMA public TO app_user;
GRANT EXECUTE ON FUNCTION app_current_tenant(), app_current_user() TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, auth_sessions, auth_accounts, auth_verifications TO app_user;
GRANT SELECT, INSERT, UPDATE ON organizations TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON organization_members TO app_user;
GRANT SELECT, INSERT ON audit_events TO app_user;
