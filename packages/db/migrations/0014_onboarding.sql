-- 0014: Fast onboarding (plug-and-play wizard). Additive only.
-- Rollback: packages/db/rollback/0014_onboarding.down.sql
--
-- Tracks industry, timezone and wizard completion on the organization itself.
-- No new tenant table (checklist is derived from existing rows + these columns).
-- Does not change approval tiers, consent rules, or RLS.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS industry text
    CHECK (industry IS NULL OR industry IN ('roofing', 'general')),
  ADD COLUMN IF NOT EXISTS timezone text
    CHECK (timezone IS NULL OR (length(timezone) BETWEEN 1 AND 64)),
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_step text
    CHECK (onboarding_step IS NULL OR length(onboarding_step) <= 40);

COMMENT ON COLUMN organizations.industry IS 'Wizard industry preset: roofing (Scout storm intel) or general SMB.';
COMMENT ON COLUMN organizations.onboarding_completed_at IS 'Set when the guided setup wizard finishes. Null means setup is still open.';

-- One-click DEMO removal: app_user may DELETE demo-flagged Scout rows.
-- RLS still forces tenant_id = app_current_tenant(); no cross-tenant deletes.
GRANT DELETE ON opportunities, opportunity_events, signal_observations, intelligence_sources TO app_user;
