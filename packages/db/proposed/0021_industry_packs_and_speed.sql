-- 0021 (PROPOSED, NOT APPLIED): industry pack id and appointment/speed tables.
-- The running app stores the pack id, staged templates, example menu, and
-- lead timing in memory_records (scope_ref speed:*) because this file is not
-- applied. organizations.industry stays roofing|general until this is reviewed.
-- Rollback: 0021_industry_packs_and_speed.down.sql
BEGIN;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS industry_pack text,
  ADD COLUMN IF NOT EXISTS industry_pack_version integer;

COMMENT ON COLUMN organizations.industry_pack IS 'Industry pack id (data file), e.g. hvac or nail_salon. Not applied yet.';

CREATE TABLE service_menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pack_service_id text NOT NULL,
  label text NOT NULL,
  duration_minutes integer,
  price_cents integer,
  price_is_example boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id)
);

CREATE TABLE bookable_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('staff', 'chair', 'bay')),
  UNIQUE (tenant_id, id)
);

CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id uuid,
  resource_id uuid,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('booked', 'completed', 'no_show', 'late_cancel', 'cancelled')),
  UNIQUE (tenant_id, id)
);

CREATE TABLE response_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  name text NOT NULL,
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('ready_to_approve', 'approved')),
  approved_by text,
  approved_at timestamptz,
  UNIQUE (tenant_id, id)
);

COMMIT;
