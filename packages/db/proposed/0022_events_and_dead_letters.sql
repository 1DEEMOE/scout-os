-- 0022 (PROPOSED, NOT APPLIED): durable event bus, dead letters, and breaker state.
-- The running app still journals through audit_events (ops.event / ops.dead_letter)
-- until this file is moved into migrations/ after review.
-- Rollback: 0022_events_and_dead_letters.down.sql

CREATE TABLE integration_events (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  type             text NOT NULL CHECK (length(type) BETWEEN 1 AND 80),
  source           text NOT NULL CHECK (length(source) BETWEEN 1 AND 80),
  status           text NOT NULL CHECK (status IN ('done', 'skipped', 'dead')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX integration_events_tenant_idx ON integration_events (tenant_id, created_at DESC);

CREATE TABLE dead_letters (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_key    text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  type         text NOT NULL CHECK (length(type) BETWEEN 1 AND 80),
  source       text NOT NULL CHECK (length(source) BETWEEN 1 AND 80),
  integration  text NOT NULL DEFAULT '',
  error        text NOT NULL CHECK (length(error) BETWEEN 1 AND 300),
  attempts     integer NOT NULL CHECK (attempts > 0),
  replayed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, event_key)
);
CREATE INDEX dead_letters_tenant_idx ON dead_letters (tenant_id, created_at DESC);

CREATE TABLE integration_breakers (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  state       text NOT NULL CHECK (state IN ('closed', 'open', 'half_open')),
  failures    integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  open_until  timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

ALTER TABLE integration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_events FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_events_tenant ON integration_events
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_letters FORCE ROW LEVEL SECURITY;
CREATE POLICY dead_letters_tenant ON dead_letters
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE integration_breakers ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_breakers FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_breakers_tenant ON integration_breakers
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT ON integration_events TO app_user;
GRANT SELECT, INSERT, UPDATE ON dead_letters, integration_breakers TO app_user;

-- The audit page filters action with a prefix. This index is unused until adopted.
CREATE INDEX audit_events_tenant_action_idx ON audit_events (tenant_id, action);
