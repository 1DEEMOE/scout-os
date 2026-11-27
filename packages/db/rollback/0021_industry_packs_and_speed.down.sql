-- Rollback for 0021. -- Fails if any organization.industry is outside roofing|general; clear those
-- rows (or move them) before rolling back.

DROP TABLE IF EXISTS appointments;
DROP TABLE IF EXISTS response_templates;
DROP TABLE IF EXISTS bookable_resources;
DROP TABLE IF EXISTS service_menu_items;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_industry_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_industry_check
  CHECK (industry IS NULL OR industry IN ('roofing', 'general'));
COMMENT ON COLUMN organizations.industry IS 'Wizard industry preset: roofing (Scout storm intel) or general SMB.';
DELETE FROM schema_migrations WHERE name = '0021_industry_packs_and_speed.sql';
