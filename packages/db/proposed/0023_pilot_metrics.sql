-- 0023 (PROPOSED, NOT APPLIED): a durable row for pilot measurements.
-- The running app stores the same numbers in memory_records (scope_ref pilot:metrics)
-- until this file is moved into migrations/ after review.
-- Rollback: 0023_pilot_metrics.down.sql

CREATE TABLE pilot_metrics (
  id                       uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  setup_started_at         timestamptz,
  setup_finished_at        timestamptz,
  first_reply_approved_at  timestamptz,
  bookings_recovered       integer NOT NULL DEFAULT 0 CHECK (bookings_recovered >= 0),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id)
);

ALTER TABLE pilot_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE pilot_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY pilot_metrics_tenant ON pilot_metrics
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON pilot_metrics TO app_user;
