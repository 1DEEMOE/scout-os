-- Rollback for 0027_crm_pipeline.sql (PROPOSED): drops the CRM pipeline
-- tables and restores the contacts.source CHECK without 'web_form'.
-- Interim data in memory_records (deal:*, note:*, leadform:*, pipeline-config)
-- is untouched; the app keeps working on it.

DROP TABLE IF EXISTS lead_forms;
DROP TABLE IF EXISTS contact_notes;
DROP TABLE IF EXISTS pipeline_configs;
DROP TABLE IF EXISTS deals;

ALTER TABLE contacts DROP CONSTRAINT contacts_source_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_source_check
  CHECK (source IN ('manual', 'inbox', 'crm_sync', 'agent'));
