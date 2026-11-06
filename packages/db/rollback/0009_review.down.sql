-- Reverses 0009_review.sql. Run as wos_owner, after a backup.
-- Drops task titles and the pause state (agents resume). No other data is touched.
BEGIN;
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_pause_attributed;
ALTER TABLE organizations DROP COLUMN IF EXISTS agents_paused_by;
ALTER TABLE organizations DROP COLUMN IF EXISTS agents_paused_at;
ALTER TABLE tasks DROP COLUMN IF EXISTS title;
DELETE FROM schema_migrations WHERE name = '0009_review.sql';
COMMIT;
