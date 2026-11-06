-- Rollback for proposed 0020.
BEGIN;
ALTER TABLE routines DROP COLUMN IF EXISTS watch_topics;
ALTER TABLE organizations DROP COLUMN IF EXISTS brand_accent;
DELETE FROM schema_migrations WHERE name = '0020_workspace_brand_and_watch.sql';
COMMIT;
