-- 0006: tenant-isolated memory (Milestone 7).
-- working: notes an agent keeps for one task. org: facts about the business.
-- trust: user (typed by a person), verified (agent-proposed, approved by a
-- person), agent (agent-written, working layer only).

CREATE TABLE memory_records (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  layer             text NOT NULL CHECK (layer IN ('working', 'org')),
  scope_ref         text NOT NULL,
  content           text NOT NULL CHECK (length(content) BETWEEN 1 AND 2000),
  source_ref        text,
  created_by_agent  uuid,
  created_by_user   text,
  trust             text NOT NULL CHECK (trust IN ('user', 'verified', 'agent')),
  search            tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  -- Org memory is only ever user-written or human-verified.
  CHECK (layer = 'working' OR trust IN ('user', 'verified')),
  CHECK (created_by_agent IS NOT NULL OR created_by_user IS NOT NULL)
);
CREATE INDEX memory_records_search_idx ON memory_records USING gin (search);
CREATE INDEX memory_records_scope_idx ON memory_records (tenant_id, layer, scope_ref);

ALTER TABLE memory_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_records FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_records_tenant ON memory_records USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, DELETE ON memory_records TO app_user;
