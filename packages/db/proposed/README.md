# Proposed migrations (not applied)

Files here are **proposals for Darian's SQL review**. The migration runner
(`src/migrate.ts`) only reads `../migrations/`, so nothing in this folder is
ever applied automatically. To adopt one after review: move it into
`../migrations/`, move its rollback into `../rollback/`, add the Drizzle
columns in `src/schema.ts`, and run `scripts/test-rollbacks.sh`.

| File | Why | Code that waits on it |
|---|---|---|
| `0020_workspace_brand_and_watch.sql` | Per-workspace accent colour (branding set by the operator), and which briefing sections a workspace wants | Admin screen accent picker; "What should Scout watch?" topic filter. Today both are honestly absent: workspaces show their name and initial, and the briefing covers every section. |
