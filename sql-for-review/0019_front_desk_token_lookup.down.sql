-- Rollback for 0019. Public booking lookups then need DATABASE_URL_ADMIN again.
BEGIN;
DROP POLICY IF EXISTS front_desk_channels_by_token ON front_desk_channels;
DELETE FROM schema_migrations WHERE name = '0019_front_desk_token_lookup.sql';
COMMIT;
