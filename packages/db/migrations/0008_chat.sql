-- 0008: lead bot chat (Milestone 12).
-- A thread is an org-scoped conversation between people and the lead bot.
-- The lead bot never acts itself: it creates ordinary tasks for the preset
-- agents, which then go through the normal policy and approval path.
-- chat_delegations links a lead bot message to each task it created.

CREATE TABLE chat_threads (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id)
);
CREATE INDEX chat_threads_recent_idx ON chat_threads (tenant_id, updated_at DESC);

CREATE TABLE chat_messages (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  thread_id       uuid NOT NULL,
  author_type     text NOT NULL CHECK (author_type IN ('user', 'lead')),
  author_user_id  text,
  content         text NOT NULL CHECK (length(content) BETWEEN 1 AND 8000),
  provider        text,
  model           text,
  mock            boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES chat_threads (tenant_id, id) ON DELETE CASCADE,
  CHECK ((author_type = 'user') = (author_user_id IS NOT NULL))
);
CREATE INDEX chat_messages_thread_idx ON chat_messages (tenant_id, thread_id, created_at);

CREATE TABLE chat_delegations (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  thread_id   uuid NOT NULL,
  message_id  uuid NOT NULL,
  task_id     uuid NOT NULL,
  agent_kind  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, task_id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES chat_threads (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, message_id) REFERENCES chat_messages (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX chat_delegations_thread_idx ON chat_delegations (tenant_id, thread_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_threads', 'chat_messages', 'chat_delegations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t || '_tenant', t);
  END LOOP;
END $$;

-- Messages and delegations are append-only for the app; threads only get their timestamp/title updated.
GRANT SELECT, INSERT, UPDATE ON chat_threads TO app_user;
GRANT SELECT, INSERT ON chat_messages, chat_delegations TO app_user;

-- Client-supplied message reference, so a double-sent message is stored once.
ALTER TABLE chat_messages ADD COLUMN client_ref text CHECK (length(client_ref) <= 100);
CREATE UNIQUE INDEX chat_messages_client_ref_idx ON chat_messages (tenant_id, thread_id, client_ref) WHERE client_ref IS NOT NULL;

-- Tier 4: the second confirmation must come from a different person than the first approval.
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_distinct_confirmer
  CHECK (confirmed_by IS NULL OR confirmed_by IS DISTINCT FROM decided_by);
