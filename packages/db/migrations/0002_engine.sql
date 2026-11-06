-- 0002: agents, tasks, workflow steps and approvals (Milestone 2).

-- Child tables reference (tenant_id, id) so a row can never point at
-- another tenant's parent, even through a bug.

CREATE TABLE agents (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('orchestrator', 'inbox', 'sales', 'finance', 'scheduling', 'reporting')),
  display_name        text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  current_version_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, kind)
);

-- Immutable: the app may insert and read versions, never change them.
CREATE TABLE agent_versions (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  agent_id        uuid NOT NULL,
  version         integer NOT NULL CHECK (version > 0),
  model_policy    jsonb NOT NULL DEFAULT '{}'::jsonb,
  instructions    text NOT NULL,
  tool_allowlist  text[] NOT NULL DEFAULT '{}',
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, agent_id, version),
  FOREIGN KEY (tenant_id, agent_id) REFERENCES agents (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE agents ADD FOREIGN KEY (tenant_id, current_version_id) REFERENCES agent_versions (tenant_id, id);

CREATE TABLE agent_permissions (
  tenant_id                   uuid NOT NULL,
  agent_id                    uuid NOT NULL,
  tool_name                   text NOT NULL,
  integration_connection_id   uuid,
  max_tier                    smallint NOT NULL CHECK (max_tier BETWEEN 0 AND 4),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id, tool_name),
  FOREIGN KEY (tenant_id, agent_id) REFERENCES agents (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE tasks (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_task_id     uuid,
  requested_by       text NOT NULL,
  assigned_agent_id  uuid,
  intent             text NOT NULL CHECK (length(intent) BETWEEN 1 AND 2000),
  state              text NOT NULL DEFAULT 'REQUESTED' CHECK (state IN (
                       'REQUESTED', 'CLASSIFIED', 'PLANNED', 'POLICY_CHECKED', 'WAITING_FOR_APPROVAL',
                       'ASSIGNED', 'EXECUTING', 'VERIFYING', 'COMPLETED', 'RETRY_SCHEDULED',
                       'ESCALATED', 'FAILED', 'COMPENSATING')),
  version            integer NOT NULL DEFAULT 0,
  input              jsonb NOT NULL DEFAULT '{}'::jsonb,
  plan               jsonb,
  result             jsonb,
  error              jsonb,
  attempts           integer NOT NULL DEFAULT 0,
  deadline           timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_task_id) REFERENCES tasks (tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_agent_id) REFERENCES agents (tenant_id, id)
);
CREATE INDEX tasks_tenant_state_idx ON tasks (tenant_id, state, updated_at DESC);

CREATE TABLE task_dependencies (
  tenant_id           uuid NOT NULL,
  task_id             uuid NOT NULL,
  depends_on_task_id  uuid NOT NULL,
  PRIMARY KEY (tenant_id, task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, depends_on_task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE
);

-- One row per attempt at one step. The idempotency key is what external
-- calls carry, so a retried step can find out whether it already happened.
CREATE TABLE workflow_executions (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  task_id          uuid NOT NULL,
  step             text NOT NULL,
  attempt          integer NOT NULL CHECK (attempt > 0),
  status           text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  idempotency_key  text NOT NULL,
  output           jsonb,
  error            text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, task_id, step, attempt),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX workflow_executions_key_idx ON workflow_executions (tenant_id, idempotency_key);

CREATE TABLE approval_requests (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  task_id         uuid NOT NULL,
  agent_id        uuid NOT NULL,
  tool_name       text NOT NULL,
  tier            smallint NOT NULL CHECK (tier BETWEEN 2 AND 4),
  action_digest   text NOT NULL CHECK (action_digest ~ '^[0-9a-f]{64}$'),
  payload         jsonb NOT NULL,
  summary         text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending', 'awaiting_confirmation', 'approved', 'rejected', 'expired', 'consumed')),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  decided_by      text,
  decided_at      timestamptz,
  confirmed_by    text,
  confirmed_at    timestamptz,
  consumed_at     timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, agent_id) REFERENCES agents (tenant_id, id),
  CHECK (expires_at > requested_at),
  -- Consumed means it was approved and used exactly once.
  CHECK (status <> 'consumed' OR (consumed_at IS NOT NULL AND decided_at IS NOT NULL)),
  -- Tier 4 needs a second, separate confirmation before it can be used.
  CHECK (tier < 4 OR status NOT IN ('approved', 'consumed') OR confirmed_at IS NOT NULL)
);
-- At most one open request for the same exact action.
CREATE UNIQUE INDEX approval_requests_open_digest_idx ON approval_requests (tenant_id, action_digest)
  WHERE status IN ('pending', 'awaiting_confirmation', 'approved');
CREATE INDEX approval_requests_tenant_status_idx ON approval_requests (tenant_id, status, requested_at DESC);

ALTER TABLE audit_events ADD FOREIGN KEY (tenant_id, approval_request_id) REFERENCES approval_requests (tenant_id, id);

-- ---------- Row-level security: same rule on every table ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agents', 'agent_versions', 'agent_permissions', 'tasks',
                           'task_dependencies', 'workflow_executions', 'approval_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
                   t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON agents, tasks, workflow_executions, approval_requests TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_permissions, task_dependencies TO app_user;
GRANT SELECT, INSERT ON agent_versions TO app_user;
