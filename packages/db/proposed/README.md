# Proposed migrations (not applied)

Files here are **proposals for Darian's SQL review**. The migration runner
(`src/migrate.ts`) only reads `../migrations/`, so nothing in this folder is
ever applied automatically. To adopt one after review: move it into
`../migrations/`, move its rollback into `../rollback/`, add the Drizzle
columns in `src/schema.ts`, and run `scripts/test-rollbacks.sh`.

| File | Why | Code that waits on it |
|---|---|---|
| `0020_workspace_brand_and_watch.sql` | Per-workspace accent colour (branding set by the operator), and which briefing sections a workspace wants | Admin screen accent picker; "What should Scout watch?" topic filter. Today both are honestly absent: workspaces show their name and initial, and the briefing covers every section. |
| `0021_signal_feeds_and_claims.sql` | Record MOCK and county permit feeds as their own source kinds; `permit` signals; `job_claims` (carrier, claim and policy numbers, loss date) under forced RLS | Finder stores MOCK storms as DEMO SPC-shaped rows and permits as prospects until then; the claim packet PDF omits claim numbers until then. |
