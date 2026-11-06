-- Rolls back 0015. Drops auth rate-limit counters.
BEGIN;
DROP TABLE IF EXISTS rate_limits;
DELETE FROM schema_migrations WHERE name = '0015_auth_rate_limits.sql';
COMMIT;
