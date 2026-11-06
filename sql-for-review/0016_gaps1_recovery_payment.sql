-- 0016: gaps-1 — routine-run recovery scanner + payment-detail change guard.
-- Rollback: packages/db/rollback/0016_gaps1_recovery_payment.down.sql
--
-- routine_recoveries: one row per (routine, scheduled instant) that was
-- re-queued after a lost job. UNIQUE makes recovery idempotent.
-- payment_destinations: verified remittance targets (account ciphertext; last4 only for UI).
-- payment_detail_changes: pending bank/remittance changes that ALWAYS need tier ≥3
-- approval AND a recorded call-back on a phone already on file (never from the request).

CREATE TABLE routine_recoveries (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  routine_id      uuid NOT NULL,
  scheduled_for   timestamptz NOT NULL,
  recovered_at    timestamptz NOT NULL DEFAULT now(),
  reason          text NOT NULL CHECK (reason IN ('missing_job', 'expired_job')),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, routine_id, scheduled_for),
  FOREIGN KEY (tenant_id, routine_id) REFERENCES routines (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX routine_recoveries_recent_idx ON routine_recoveries (tenant_id, recovered_at DESC);

CREATE TABLE payment_destinations (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('customer', 'vendor', 'payee')),
  contact_id         uuid,
  label              text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  -- Last four of account / routing for display only. Full values live in ciphertext.
  account_last4      text NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
  routing_last4      text CHECK (routing_last4 IS NULL OR routing_last4 ~ '^[0-9]{4}$'),
  ciphertext         text NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'replaced')),
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (contact_id)
);
CREATE INDEX payment_destinations_contact_idx ON payment_destinations (tenant_id, contact_id) WHERE contact_id IS NOT NULL;

CREATE TABLE payment_detail_changes (
  id                      uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind                    text NOT NULL CHECK (kind IN ('customer', 'vendor', 'payee')),
  contact_id              uuid,
  destination_id          uuid,
  label                   text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  -- Proposed last4 only in this table; never store full account numbers here.
  proposed_account_last4  text NOT NULL CHECK (proposed_account_last4 ~ '^[0-9]{4}$'),
  proposed_routing_last4  text CHECK (proposed_routing_last4 IS NULL OR proposed_routing_last4 ~ '^[0-9]{4}$'),
  proposed_ciphertext     text NOT NULL,
  -- Source of the request (agent / email / chat / user). Email and chat always need approval.
  source                  text NOT NULL CHECK (source IN ('agent', 'email', 'chat', 'user')),
  approval_request_id     uuid,
  task_id                 uuid,
  status                  text NOT NULL DEFAULT 'awaiting_callback'
    CHECK (status IN ('awaiting_callback', 'awaiting_approval', 'approved', 'rejected', 'cancelled')),
  -- Call-back must use a number already on the contact, never one from the change request.
  callback_phone_used     text,
  callback_verified_at    timestamptz,
  callback_verified_by    text,
  callback_notes          text CHECK (callback_notes IS NULL OR length(callback_notes) <= 1000),
  flagged_on_home         boolean NOT NULL DEFAULT true,
  created_by              text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  resolved_at             timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, destination_id) REFERENCES payment_destinations (tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, approval_request_id) REFERENCES approval_requests (tenant_id, id) ON DELETE SET NULL,
  CHECK ((callback_verified_at IS NULL) = (callback_verified_by IS NULL)),
  CHECK (status <> 'approved' OR callback_verified_at IS NOT NULL)
);
CREATE INDEX payment_detail_changes_open_idx
  ON payment_detail_changes (tenant_id, status, created_at DESC)
  WHERE status IN ('awaiting_callback', 'awaiting_approval');
CREATE INDEX payment_detail_changes_approval_idx
  ON payment_detail_changes (tenant_id, approval_request_id)
  WHERE approval_request_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['routine_recoveries', 'payment_destinations', 'payment_detail_changes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t || '_tenant', t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON routine_recoveries, payment_destinations, payment_detail_changes TO app_user;
-- No DELETE for payment history or recovery log from the app.
