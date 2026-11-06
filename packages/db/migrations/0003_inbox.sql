-- 0003: integrations, mailbox identities, conversations and messages (Milestone 3).

-- Audit entries written in one transaction share a timestamp; seq gives a
-- stable order for the audit viewer.
ALTER TABLE audit_events ADD COLUMN seq bigserial;
CREATE INDEX audit_events_tenant_seq_idx ON audit_events (tenant_id, seq DESC);

CREATE TABLE integration_connections (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider           text NOT NULL CHECK (provider IN ('google', 'hubspot', 'stripe')),
  account_label      text NOT NULL,
  scopes             text[] NOT NULL DEFAULT '{}',
  -- Key id of the encryption key used; the ciphertext is useless without that key,
  -- which lives outside the database (WOS_SECRETS_KEY).
  secret_ref         text NOT NULL,
  secret_ciphertext  text NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, account_label)
);

CREATE TABLE email_identities (
  id                          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL,
  integration_connection_id   uuid NOT NULL,
  address                     text NOT NULL,
  mode                        text NOT NULL DEFAULT 'draft_only' CHECK (mode IN ('draft_only', 'send_with_approval')),
  sync_cursor                 text,
  last_synced_at              timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, address),
  FOREIGN KEY (tenant_id, integration_connection_id) REFERENCES integration_connections (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE conversations (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email_identity_id   uuid,
  channel             text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  subject             text NOT NULL DEFAULT '',
  external_thread_id  text NOT NULL,
  category            text CHECK (category IN ('lead', 'client_request', 'billing', 'scheduling', 'vendor', 'spam', 'other')),
  summary             text,
  draft_external_id   text,
  draft_message_id    text,
  draft_body          text,
  last_message_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel, external_thread_id),
  FOREIGN KEY (tenant_id, email_identity_id) REFERENCES email_identities (tenant_id, id) ON DELETE SET NULL (email_identity_id)
);
CREATE INDEX conversations_tenant_recent_idx ON conversations (tenant_id, last_message_at DESC);

CREATE TABLE messages (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  conversation_id  uuid NOT NULL,
  direction        text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender           text NOT NULL,
  recipients       text[] NOT NULL DEFAULT '{}',
  subject          text NOT NULL DEFAULT '',
  body             text NOT NULL DEFAULT '' CHECK (length(body) <= 100000),
  external_id      text NOT NULL,
  rfc822_message_id text,
  sent_at          timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, external_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX messages_conversation_idx ON messages (tenant_id, conversation_id, sent_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_connections', 'email_identities', 'conversations', 'messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
                   t || '_tenant', t);
  END LOOP;
END $$;

GRANT USAGE, SELECT ON SEQUENCE audit_events_seq_seq TO app_user;
GRANT SELECT, INSERT, UPDATE ON integration_connections, email_identities, conversations TO app_user;
GRANT SELECT, INSERT ON messages TO app_user;
