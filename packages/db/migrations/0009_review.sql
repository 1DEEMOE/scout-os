-- 0009: UX review follow-ups. Additive only: new nullable columns, no data rewritten.
-- Rollback: packages/db/rollback/0009_review.down.sql

-- Short human title for the task list; `intent` stays the full instruction the agent receives.
ALTER TABLE tasks ADD COLUMN title text CHECK (title IS NULL OR length(title) BETWEEN 1 AND 200);

-- Kill switch: while set, no agent takes a step and the lead bot hands nothing off.
ALTER TABLE organizations ADD COLUMN agents_paused_at timestamptz;
ALTER TABLE organizations ADD COLUMN agents_paused_by text;
ALTER TABLE organizations ADD CONSTRAINT organizations_pause_attributed
  CHECK ((agents_paused_at IS NULL) = (agents_paused_by IS NULL));
