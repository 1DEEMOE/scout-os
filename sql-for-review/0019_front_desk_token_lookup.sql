-- 0019: Public booking links without a god credential.
--
-- A booking link carries only its token, not the tenant, so the token lookup
-- used the admin connection (superuser/BYPASSRLS) from the internet-facing web
-- process. That broke least privilege (Law 5), and on hosts whose default
-- database user isn't a superuser (Render) every booking link would 404.
--
-- This adds one narrow, read-only policy: app_user may SELECT the single
-- front_desk_channels row whose token_hash equals the transaction-local
-- setting app.front_desk_token_hash. Knowing the hash requires holding the
-- link's token (it's SHA-256 of a 24-byte random value), so this exposes
-- nothing the caller doesn't already have. Policies are permissive (OR), so
-- tenant access is unchanged; nothing else is readable this way.
-- Additive only. Rollback: packages/db/rollback/0019_front_desk_token_lookup.down.sql

CREATE POLICY front_desk_channels_by_token ON front_desk_channels
  FOR SELECT
  USING (
    current_setting('app.front_desk_token_hash', true) IS NOT NULL
    AND current_setting('app.front_desk_token_hash', true) <> ''
    AND token_hash = current_setting('app.front_desk_token_hash', true)
  );
