-- Rollback for proposed 0021. Refuses if any new-kind rows exist (no silent data loss).
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM signal_observations WHERE kind = 'permit')
     OR EXISTS (SELECT 1 FROM intelligence_sources WHERE kind IN ('mock_storm_feed', 'mock_permit_feed', 'county_permits')) THEN
    RAISE EXCEPTION 'Rows use 0021 kinds; back them up and remove them before rolling back';
  END IF;
END $$;
DROP TABLE IF EXISTS job_claims;
ALTER TABLE signal_observations DROP CONSTRAINT signal_observations_kind_check;
ALTER TABLE signal_observations ADD CONSTRAINT signal_observations_kind_check CHECK (kind IN ('hail', 'wind', 'tornado'));
ALTER TABLE intelligence_sources DROP CONSTRAINT intelligence_sources_kind_check;
ALTER TABLE intelligence_sources ADD CONSTRAINT intelligence_sources_kind_check CHECK (kind IN ('noaa_spc_storm_reports', 'crm_contacts', 'customer_import'));
DELETE FROM schema_migrations WHERE name = '0021_signal_feeds_and_claims.sql';
COMMIT;
