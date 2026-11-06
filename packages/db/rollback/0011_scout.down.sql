BEGIN;
-- Rollback for 0011_scout.sql. Drops Scout data: take a backup first (pg_dump -t 'business_profiles' ... ) per Law 7.
-- Fails if any agent of kind 'scout' exists; delete those agents first.
DROP TABLE IF EXISTS outreach_events, suppression_list, communication_permissions, opportunity_events,
  opportunities, prospects, signal_observations, intelligence_sources, business_profiles;
ALTER TABLE agents DROP CONSTRAINT agents_kind_check;
ALTER TABLE agents ADD CONSTRAINT agents_kind_check
  CHECK (kind IN ('orchestrator', 'inbox', 'sales', 'finance', 'scheduling', 'reporting'));
DELETE FROM schema_migrations WHERE name = '0011_scout.sql';
COMMIT;
