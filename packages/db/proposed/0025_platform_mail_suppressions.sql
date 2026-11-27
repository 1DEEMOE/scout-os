-- 0025 (PROPOSED, NOT APPLIED): platform-wide mail suppression for the SaaS's own
-- transactional email (magic links, password resets, receipts) — NOT tenant outreach
-- (that is the tenant-scoped suppression_list). Global like rate_limits: a bounce is a
-- property of the address, not of a tenant. Rollback: 0025_platform_mail_suppressions.down.sql

CREATE TABLE platform_mail_suppressions (
  address    text PRIMARY KEY CHECK (address = lower(address) AND position('@' IN address) > 1),
  reason     text NOT NULL CHECK (reason IN ('bounce', 'complaint')),
  source     text NOT NULL CHECK (length(source) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_mail_soft_bounces (
  address    text PRIMARY KEY CHECK (address = lower(address)),
  count      integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Global platform tables: no RLS (same shape as rate_limits in 0015).
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_mail_suppressions, platform_mail_soft_bounces TO app_user;
