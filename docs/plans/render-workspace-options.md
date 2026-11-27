# Render: database is in the wrong workspace

Finding (from an earlier read-only look): `scout-os-db` is in Render workspace "My Workspace" (a different login), not your FLOW workspace. I have not changed anything on Render and will not unless you say so.

Why it matters: billing, access, backups and who can delete the database all follow the workspace. A production database owned by a personal/other account is a risk to you and to customers.

## Options
| Option | What it is | Downtime | Risk | Cost |
|---|---|---|---|---|
| A. Recreate in FLOW (recommended) | Blueprint creates new db/web/worker in FLOW; restore a verified backup; point nothing live until verified | none (staging has no customers) | low | Render smallest plans (~$7–15/mo), your existing plan decision |
| B. Transfer ownership | Render supports transferring a service between workspaces you own; database transfer rules differ | short | medium: needs both accounts and Render's own rules | none extra |
| C. Leave it and invite yourself | Add yourself as an admin on the old workspace | none | high: still the wrong owner | none |

Because nothing real is in the database yet (no pilot), A is cleanest: nothing to migrate.

## Steps for A (you do the clicks and the signup/billing decisions)
1. In FLOW, connect the GitHub repo and create the Blueprint from `render.yaml`. This creates `scout-os-db`, `scout-os-web`, `scout-os-worker`, and the env group. **That costs money; it is your call (no paid services without your go).**
2. Before first deploy, connect as Render's default user and run `scripts/render-db-roles.sql` (creates `wos_owner`, `app_user`; the app must never use the default user).
3. Run `pnpm db:backup` against the OLD database if it holds anything you care about, and download and open the dump. Otherwise skip.
4. Apply migrations as `wos_owner`: `DATABASE_URL_OWNER=<url> pnpm db:migrate` (see `staging-runbook.md`).
5. Set staging secrets yourself. Back up `WOS_SECRETS_KEY` separately.
6. After the new stack passes the runbook checks, delete the old workspace's services.

Tell me "go ahead with Render read-only" if you want me to re-inspect the old workspace and write down exactly what is in it.
