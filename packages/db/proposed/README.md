# Proposed migrations (not applied)

Files here are **proposals for Darian's SQL review**. The migration runner
(`src/migrate.ts`) only reads `../migrations/`, so nothing in this folder is
ever applied automatically. To adopt one after review: move it into
`../migrations/`, move its rollback into `../rollback/`, add the Drizzle
columns in `src/schema.ts`, and run `scripts/test-rollbacks.sh`.

| File | Why | Code that waits on it |
|---|---|---|
| `0020_workspace_brand_and_watch.sql` | Per-workspace accent colour (branding set by the operator), and which briefing sections a workspace wants | Admin screen accent picker; "What should Scout watch?" topic filter. Today both are honestly absent: workspaces show their name and initial, and the briefing covers every section. |
| `0021_industry_packs_and_speed.sql` | Widen `organizations.industry` to the pack ids, and add menu, chair/bay, appointment, and reply-template tables with the same RLS, grants, and tenant foreign keys as 0001–0019 | Not applied. The app still stores the pack, menu, templates, and visits in `memory_records` (`speed:*`). `packages/db/test/proposed-0021-isolation.test.ts` applies this file inside a transaction and rolls it back. |
| `0022_events_and_dead_letters.sql` | Durable integration events, dead letters, breaker rows, and an audit action index. Same RLS and grants as 0001–0019 | Not applied. The bus journals `ops.event` and `ops.dead_letter` on `audit_events`, and the breaker is in-process. `packages/db/test/proposed-0022-isolation.test.ts` applies this file inside a transaction and rolls it back. |
| `0023_pilot_metrics.sql` | One row per workspace for setup time, first-reply approval time, and bookings recovered | Not applied. The app stores those numbers in `memory_records` (`pilot:metrics`). Hours saved is computed from morning briefings that ran. `packages/db/test/proposed-0023-isolation.test.ts` applies this file inside a transaction and rolls it back. |
