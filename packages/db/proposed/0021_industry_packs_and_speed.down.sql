-- Rollback for proposed 0021. Not applied.
BEGIN;
DROP TABLE IF EXISTS appointments;
DROP TABLE IF EXISTS bookable_resources;
DROP TABLE IF EXISTS service_menu_items;
DROP TABLE IF EXISTS response_templates;
ALTER TABLE organizations DROP COLUMN IF EXISTS industry_pack;
ALTER TABLE organizations DROP COLUMN IF EXISTS industry_pack_version;
COMMIT;
