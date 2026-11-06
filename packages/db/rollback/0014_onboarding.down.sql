-- Rolls back 0014. Removes wizard columns; demo DELETE grants revoked.
BEGIN;
REVOKE DELETE ON opportunities, opportunity_events, signal_observations, intelligence_sources FROM app_user;
ALTER TABLE organizations
  DROP COLUMN IF EXISTS onboarding_step,
  DROP COLUMN IF EXISTS onboarding_completed_at,
  DROP COLUMN IF EXISTS timezone,
  DROP COLUMN IF EXISTS industry;
DELETE FROM schema_migrations WHERE name = '0014_onboarding.sql';
COMMIT;
