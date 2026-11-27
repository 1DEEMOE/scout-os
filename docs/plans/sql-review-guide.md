# SQL review guide for the owner (0020–0023 edits, 0028, 0029)

Written by Claude. It is a reading aid, **not** an independent review: you do the review. Read the real files in `sql-for-review/` (they are byte-identical to `packages/db/migrations/` and `rollback/`; `pnpm check:sql-review` proves it). Nothing here has been applied to any real database.

How to review: for each file, read the statement, read my "what it does", then answer the "your check" question. About 20 minutes for all of it. Everything runs inside one transaction per file (except 0029), so a failure leaves no partial change.

## Order they apply
0020 → 0021 → 0022 → 0023 → 0028 → 0029. 0013–0019 are already applied (never independently reviewed; same reading applies if you want to cover them).

## 0020 workspace brand + watch topics (additive)
- Adds `organizations.brand_accent` (one of 7 fixed hex colours or NULL) and `routines.watch_topics` (a text[] of known section ids that must include `pending_approvals`, or NULL = all).
- Risk: low. Only adds nullable columns. `IF NOT EXISTS` makes a re-run harmless.
- Your check: is it right that the approvals section can never be filtered out of a briefing? (It is enforced in the database.)

## 0021 industry packs and speed (new tables + widens a CHECK)
- Widens `organizations_industry_check` from 2 values to the 60 pack ids (a test, `pack-ids.test.ts`, fails if code and SQL lists drift).
- Creates `service_menu_items`, `bookable_resources`, `appointments`, `response_templates`. Each has `tenant_id`, row-level security **ENABLE + FORCE** with the same tenant policy as 0001–0019, and grants to `app_user`.
- My edits: dropped two single-column tenant indexes (covered by `UNIQUE (tenant_id, id)`), added `appointments_service_idx (tenant_id, service_id)`, added timeouts, `IF NOT EXISTS`, `DROP POLICY IF EXISTS`.
- Your check: (1) `appointments` and `response_templates` have no DELETE grant (business records are not hard-deleted by the app); is that what you want? (2) The tables are unused by the app today (decision: stay unused until a pilot needs them).
- Known defect fixed later in 0028 (the foreign keys).

## 0022 events, dead letters, breakers
- Creates `integration_events` (idempotency record, `UNIQUE (tenant_id, idempotency_key)`), `dead_letters`, `integration_breakers`; same RLS pattern.
- `integration_events` grants: SELECT, INSERT only at this point. 0028 adds the lease columns and a narrow UPDATE.
- My edit: the `audit_events` index moved out to 0029.
- Your check: after 0028, can the app change what an event *was*? (No: UPDATE is granted on four lifecycle columns only.)
- Operational: the app uses these tables by default (`WOS_DURABLE_EVENTS=0` falls back). Roll back only after reverting code or setting that flag.

## 0023 pilot metrics
- One row per tenant (`UNIQUE (tenant_id)`), non-negative counter, RLS. The app currently stores the same numbers elsewhere; low risk.

## 0028 data fixes (the one to read most carefully)
1. **Appointment foreign keys.** Old: `ON DELETE SET NULL` on a composite key tried to null `tenant_id` (NOT NULL), so deleting a service/resource failed. New: `ON DELETE SET NULL (service_id)` / `(resource_id)` nulls only the optional column. Proven by `appointment-fk.test.ts` (as `app_user`).
2. **Event lease.** Adds statuses `in_progress`, `failed`; columns `lease_owner`, `lease_expires_at`, `attempts`; a CHECK that a lease exists exactly while `in_progress`; `GRANT UPDATE (status, lease_owner, lease_expires_at, attempts)` to `app_user`. Purpose: a worker claims the key before calling Stripe/Gmail/etc., so two workers cannot both do it.
- Locks: briefly locks `appointments` and `integration_events`; `lock_timeout 5s` makes it fail fast rather than queue behind traffic.
- Your check: is a column-level UPDATE grant acceptable to you? Alternative: a SECURITY DEFINER function (more code, same effect).
- Caveat: `attempts` counts claims, not provider calls.

## 0029 audit index (runs outside a transaction on purpose)
- `CREATE INDEX CONCURRENTLY IF NOT EXISTS` so inserts into `audit_events` are not blocked while it builds. Not atomic: if interrupted it can leave an INVALID index; the file header says how to drop and re-run.
- Your check: do you accept a non-atomic migration for this one file? (It is only an index; no data changes.)

## Read-only queries to run on a **scratch** copy after applying
```sql
-- every new table has FORCE RLS
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE relname IN ('service_menu_items','bookable_resources','appointments','response_templates','integration_events','dead_letters','integration_breakers','pilot_metrics');
-- no invalid indexes
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- what app_user may do
SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee='app_user' AND table_name IN ('integration_events','appointments');
SELECT column_name, privilege_type FROM information_schema.column_privileges WHERE grantee='app_user' AND table_name='integration_events' AND privilege_type='UPDATE';
```
Expected: all `relforcerowsecurity = t`; zero invalid indexes; `integration_events` has SELECT, INSERT table-wide and UPDATE only on the four columns; `appointments` has no DELETE.

## Sign-off
When satisfied, tell me "SQL approved" naming the files. I will record it in `docs/plans/migration-review-0020-0023.md` and update `STATUS.md`. I will not treat silence as approval.
