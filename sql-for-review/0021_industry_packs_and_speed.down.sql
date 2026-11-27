-- Rollback for 0021. DESTRUCTIVE: drops appointments, response_templates, bookable_resources and
-- service_menu_items with their rows (export first if you want them). Fails, and changes nothing,
-- if any organizations.industry is outside roofing|general: clear or move those rows first.
-- All in one transaction so a failure at the CHECK re-add leaves the tables in place.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_industry_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_industry_check
  CHECK (industry IS NULL OR industry IN ('roofing', 'general'));
DROP TABLE IF EXISTS appointments;
DROP TABLE IF EXISTS response_templates;
DROP TABLE IF EXISTS bookable_resources;
DROP TABLE IF EXISTS service_menu_items;
COMMENT ON COLUMN organizations.industry IS 'Wizard industry preset: roofing (Scout storm intel) or general SMB.';
DELETE FROM schema_migrations WHERE name = '0021_industry_packs_and_speed.sql';
COMMIT;
