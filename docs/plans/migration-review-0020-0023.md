# Migration review — proposed 0020–0023

**Reviewer:** Kimi (AI assistant). This is a careful, evidence-based review, **not** the independent human review the repo's gate calls for. Treat it as a second pair of eyes; a human owner should still sign off before any production database sees these files.

**Method:** read every statement; compared RLS/grant/composite-key patterns against applied migrations 0001–0019; extracted the 60 industry pack ids from `packages/core/src/industries/overlays.ts` and diffed them against the 0021 CHECK list (exact match, zero drift); checked rollback conventions against `rollback/*.down.sql`; checked the migrator's transaction contract in `packages/db/src/migrate.ts`.

## Verdict per file

| File | Verdict | Blocking issues |
|---|---|---|
| 0020 workspace brand + watch | Approve **after fix R1** | R1 |
| 0021 industry packs + speed | Approve after fix R2 | R2 |
| 0022 events + dead letters | Approve after fix R2 | R2 |
| 0023 pilot metrics | Approve after fix R2 | R2 |

## Required fixes (applied in the adopted copies)

- **R1 (0020): remove the embedded `BEGIN;`/`COMMIT;`.** The migrator already wraps each file in its own transaction and records `schema_migrations` inside it. An inner `COMMIT` would commit early and split the file from its bookkeeping row, defeating rollback-on-failure. No applied migration (0001–0019) uses top-level transaction control — the `BEGIN` matches in 0002/0013 are plpgsql function bodies. Fixed in the adopted copy.
- **R2 (0021, 0022, 0023 down files): delete the `schema_migrations` row on rollback.** Every applied rollback (`0009`–`0019`) does `DELETE FROM schema_migrations WHERE name = …`; these three don't, so a rollback would leave the migrator believing the file is still applied. 0020's down file already does this correctly. Fixed in the adopted copies.

## Verified good (no change needed)

- **RLS pattern identical to 0001–0019:** `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy `USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())` on all six new tables. Owner role is not exempt (FORCE). ✔
- **Grants match the least-privilege pattern:** DML to `app_user` only; `integration_events` is insert-only (no UPDATE/DELETE — journal semantics); `appointments`/`response_templates` deny DELETE (no hard delete of business records); menu/resource tables allow DELETE (operator-managed reference data). ✔
- **0021 CHECK list == code pack ids:** programmatic diff of `organizations_industry_check` against the `OVERLAYS` array — 60 ids, both directions empty. The file's own warning ("a new pack id needs this list updated") is the standing drift risk; recommend a unit test asserting the two lists match (added: `packages/db/test/pack-ids.test.ts`). ✔
- **0020 `watch_topics`:** `NULL` = all sections (backwards compatible); non-null must be a subset of the known section ids **and** contain `pending_approvals` — the approvals section can never be filtered out, matching the repo law that approvals are never hidden. Empty array correctly rejected. ✔
- **0020 `brand_accent`:** fixed palette via CHECK, not free text — no CSS injection vector, no unreadable arbitrary colors. Its own note (add each candidate to `contrast.test.ts` before adoption) is honored: see the adopted test update. ✔
- **0021 composite FKs** `(tenant_id, service_id) → service_menu_items(tenant_id, id) ON DELETE SET NULL` keep cross-tenant references impossible even if `service_id` were guessed. `appointments` time CHECK (`ends_at > starts_at`) and `response_templates` status/approval coherence CHECK (`(status='approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)`) encode invariants in the database, not the app. ✔
- **0022 dead_letters:** `UNIQUE (tenant_id, event_key)` gives idempotent dead-letter recording; error length capped at 300 (bounded storage); `replayed_at` nullable timestamp supports the replay path in `events/recovery.ts`. ✔
- **0023:** one row per tenant via `UNIQUE (tenant_id)`; non-negative CHECK on `bookings_recovered`. ✔

## Non-blocking notes

- **N1 (0022):** `integration_events` has a `(tenant_id, created_at DESC)` index but no index on `type`. Fine at current volume; revisit if per-type dashboards get slow.
- **N2 (0023):** `updated_at` has no trigger; writers must set it. The service layer does — keep it that way and don't rely on the default.
- **N3 (0021):** the down file correctly warns that organizations whose `industry` is outside `roofing|general` must be cleared before rollback, since the narrowed CHECK would fail. Operationally: `UPDATE organizations SET industry='general' WHERE industry NOT IN ('roofing','general')` before rolling back.
- **N4 (0022):** adopting the tables does not by itself move the event bus off `audit_events` — the code switch in `packages/core/src/events/` (durable journal + shared breaker) is what realizes the value. The durable code is now the default; `WOS_DURABLE_EVENTS=0` falls back to the audit-trail journal.

## Adoption performed (owner approved 2026-11-23)

1. `0020`–`0023` moved `proposed/ → migrations/`, down files `proposed/ → rollback/`, with R1/R2 applied.
2. Drizzle schema updated (`packages/db/src/schema.ts`): new tables and the two new columns.
3. The 8 new tables are classified in the privacy registry (`TABLE_POLICY`, all `delete`; `appointments` precedes the tables it references in `ERASURE_ORDER`). The drift guard and the SQL-derived order test pass.
4. `proposed-002{1,2,3}-isolation.test.ts` retired. The auto-discovering `isolation.test.ts` covers the tables once migrated, with seed rows for all 8. `pack-ids.test.ts` guards the 0021 CHECK list against pack-id drift.
5. Event bus uses the durable tables by default. Event-bus tests are mode-agnostic (`activeJournal()`) and also pass with `WOS_DURABLE_EVENTS=0`.
6. `scripts/test-rollbacks.mjs` re-run after adoption: round-trip schema identical, including the four new rollbacks.

Adopting means the files are in `migrations/`; **no real database has had them applied.** Apply to staging only with the runbook, after a backup.
