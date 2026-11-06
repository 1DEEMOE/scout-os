# Proposed migrations (not applied)

Files here are **proposals for Darian's SQL review**. The migration runner
(`src/migrate.ts`) only reads `../migrations/`, so nothing in this folder is
ever applied automatically. To adopt one after review: move it into
`../migrations/`, move its rollback into `../rollback/`, add the Drizzle
columns in `src/schema.ts`, and run `scripts/test-rollbacks.sh`.

| File | Why | Code that waits on it |
|---|---|---|
| `0020_workspace_brand_and_watch.sql` | Per-workspace accent colour (branding set by the operator), and which briefing sections a workspace wants | Admin screen accent picker; "What should Scout watch?" topic filter. Today both are honestly absent: workspaces show their name and initial, and the briefing covers every section. |
| `0021_industry_packs_and_speed.sql` | Pack id on the organization, example service menu, bookable staff/chairs, appointments, and reply templates | The app already runs packs from `packages/core/src/industries/packs.ts` and stores the choice, menu, and templates in `memory_records` (`speed:*`) so nothing here is required for the current behavior. Move this in only after review, then point those writes at the tables. |
