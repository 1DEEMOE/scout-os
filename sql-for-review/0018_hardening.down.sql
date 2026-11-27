-- Rollback for 0018_hardening.sql. Reverse order.
-- NOTE: front_desk_channels.public_token cannot be restored — only hashes
-- survive. Rotate all front-desk tokens (disable + re-enable channels) after
-- rolling this migration back.

REVOKE UPDATE (integrity_status, integrity_note) ON job_photos FROM app_user;
GRANT UPDATE ON job_photos TO app_user;

DROP INDEX IF EXISTS front_desk_channels_token_hash_idx;
ALTER TABLE front_desk_channels ADD COLUMN public_token text;
-- Plaintext is unrecoverable; generate a fresh token per channel so the column
-- satisfies NOT NULL, and treat every existing channel's token as rotated.
ALTER TABLE front_desk_channels DISABLE ROW LEVEL SECURITY;
UPDATE front_desk_channels SET public_token = md5(id::text || clock_timestamp()::text || random()::text);
ALTER TABLE front_desk_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE front_desk_channels ALTER COLUMN public_token SET NOT NULL;
ALTER TABLE front_desk_channels ADD CONSTRAINT front_desk_channels_public_token_key UNIQUE (public_token);
ALTER TABLE front_desk_channels DROP CONSTRAINT front_desk_channels_token_hash_shape;
ALTER TABLE front_desk_channels DROP COLUMN token_hash;

REVOKE DELETE ON email_identities FROM app_user;
REVOKE DELETE ON integration_connections FROM app_user;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_hash_shape;
ALTER TABLE audit_events DROP COLUMN entry_hash;
ALTER TABLE audit_events DROP COLUMN prev_hash;

DROP TABLE organization_invitations;

-- Forget this migration so a later `migrate` re-applies it (otherwise it's silently skipped).
DELETE FROM schema_migrations WHERE name = '0018_hardening.sql';
