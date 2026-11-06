-- 0015: Better Auth database-backed rate limiting (password reset, sign-in).
-- Global table (no tenant): auth attempts are cross-org.
-- Rollback: packages/db/rollback/0015_auth_rate_limits.down.sql

CREATE TABLE rate_limits (
  id           text PRIMARY KEY,
  key          text NOT NULL UNIQUE,
  count        integer NOT NULL,
  last_request bigint NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limits TO app_user;
