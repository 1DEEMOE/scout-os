-- 0021 (PROPOSED, NOT APPLIED): pack ids on organizations, plus the tables a
-- reviewed pack would use for menus, chairs/bays, visits, and reply templates.
-- The app does not read these tables yet. Pack choice still lives in
-- memory_records (scope_ref speed:*) until this file is moved into migrations/
-- after review. Rollback: 0021_industry_packs_and_speed.down.sql
--
-- organizations.industry today only allows roofing|general (0014). This widens
-- that check to the pack ids in packages/core/src/industries/packs.ts.
-- A new pack id needs this list updated before the migration is adopted.

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_industry_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_industry_check CHECK (
  industry IS NULL OR industry IN (
    'roofing', 'general', 'landscaping', 'plumbing', 'construction', 'hvac', 'electrical',
    'pest_control', 'tire_shop', 'auto_repair', 'auto_glass', 'moving', 'duct_cleaning',
    'tree_service', 'nail_salon', 'hair_salon', 'esthetics', 'lash_brow',
    'painting', 'house_cleaning', 'garage_door', 'locksmith', 'flooring', 'handyman',
    'auto_detail', 'body_shop', 'yoga_studio', 'personal_training', 'wellness_studio',
    'dog_grooming', 'pet_boarding', 'pet_sitting', 'restaurant', 'cafe', 'catering', 'bakery',
    'retail_shop', 'ecommerce', 'bookkeeping_firm', 'consulting', 'real_estate', 'law_office',
    'tutoring', 'childcare', 'music_lessons', 'event_planner', 'photographer', 'venue',
    'startup_saas', 'startup_agency', 'startup_dtc',
    'barber', 'med_spa', 'dental', 'junk_removal', 'pressure_washing', 'veterinary', 'tax_prep', 'towing', 'counseling'
  )
);
COMMENT ON COLUMN organizations.industry IS 'Industry pack id. NULL until setup. See packages/core/src/industries/packs.ts.';

CREATE TABLE service_menu_items (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pack_service_id   text NOT NULL CHECK (length(pack_service_id) BETWEEN 1 AND 80),
  label             text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  duration_minutes  integer CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  price_cents       integer CHECK (price_cents IS NULL OR price_cents >= 0),
  price_is_example  boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id)
);
CREATE INDEX service_menu_items_tenant_idx ON service_menu_items (tenant_id);

CREATE TABLE bookable_resources (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind        text NOT NULL CHECK (kind IN ('staff', 'chair', 'bay')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id)
);
CREATE INDEX bookable_resources_tenant_idx ON bookable_resources (tenant_id);

CREATE TABLE appointments (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id   uuid,
  resource_id  uuid,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  status       text NOT NULL CHECK (status IN ('booked', 'completed', 'no_show', 'late_cancel', 'cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES service_menu_items (tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, resource_id) REFERENCES bookable_resources (tenant_id, id) ON DELETE SET NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX appointments_tenant_starts_idx ON appointments (tenant_id, starts_at);
CREATE INDEX appointments_resource_idx ON appointments (tenant_id, resource_id, starts_at);

CREATE TABLE response_templates (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  purpose      text NOT NULL CHECK (purpose IN ('first_response', 'rebook', 'no_show', 'late_cancel', 'review')),
  channel      text NOT NULL CHECK (channel IN ('email', 'sms')),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  status       text NOT NULL CHECK (status IN ('ready_to_approve', 'approved')),
  approved_by  text,
  approved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX response_templates_tenant_idx ON response_templates (tenant_id, status);

-- Same tenant policy as migrations 0001–0019: the row's tenant_id must be the
-- transaction's app.tenant_id. FORCE so the table owner is not exempt.
ALTER TABLE service_menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_menu_items FORCE ROW LEVEL SECURITY;
CREATE POLICY service_menu_items_tenant ON service_menu_items
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE bookable_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookable_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY bookable_resources_tenant ON bookable_resources
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
CREATE POLICY appointments_tenant ON appointments
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE response_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE response_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY response_templates_tenant ON response_templates
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON service_menu_items, bookable_resources TO app_user;
GRANT SELECT, INSERT, UPDATE ON appointments, response_templates TO app_user;
