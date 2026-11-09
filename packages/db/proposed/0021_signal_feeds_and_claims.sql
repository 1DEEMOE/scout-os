-- 0021 (PROPOSED, NOT APPLIED): signal feeds for the opportunity finder, and
-- insurance-claim details on jobs. Additive only.
-- Rollback: 0021_signal_feeds_and_claims.down.sql
-- Review notes:
--  * Today the finder stores MOCK storm reports as kind 'noaa_spc_storm_reports'
--    with demo=true (labelled DEMO), and turns MOCK permits into imported
--    prospects. This migration lets each feed be recorded as what it is.
--  * 'permit' signals let a permit be evidence in its own right (roof age),
--    instead of only producing a prospect row.
--  * job_claims holds the carrier, claim and policy numbers for an insurance job
--    so the claim packet PDF can print them. The numbers are tenant data under
--    the same forced RLS as every other tenant table.
BEGIN;

ALTER TABLE intelligence_sources DROP CONSTRAINT intelligence_sources_kind_check;
ALTER TABLE intelligence_sources ADD CONSTRAINT intelligence_sources_kind_check
  CHECK (kind IN ('noaa_spc_storm_reports', 'crm_contacts', 'customer_import', 'mock_storm_feed', 'mock_permit_feed', 'county_permits'));

ALTER TABLE signal_observations DROP CONSTRAINT signal_observations_kind_check;
ALTER TABLE signal_observations ADD CONSTRAINT signal_observations_kind_check
  CHECK (kind IN ('hail', 'wind', 'tornado', 'permit'));

CREATE TABLE job_claims (
  tenant_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id        uuid NOT NULL,
  carrier       text CHECK (char_length(carrier) <= 120),
  claim_number  text CHECK (char_length(claim_number) <= 80),
  policy_number text CHECK (char_length(policy_number) <= 80),
  loss_date     date,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, job_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES tasks(tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE job_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY job_claims_tenant ON job_claims USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON job_claims TO app_user;

COMMIT;
