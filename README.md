# Scout OS

Multi-tenant SaaS where small businesses hire AI employees (Scout, Inbox, Pipeline, Billing, Analyst, Coordinator) that find opportunities and run operations with human approval gates.

**Customer-facing name:** Scout OS. Internal package names, env vars, and DB roles still use `@wos/*` / `WOS_*` / `wos_*` so existing installs and provider metadata stay intact. A trademark clearance search for "Scout OS" (classes 9 and 42) is still required before public use — see `docs/research/ip-flags.md`.

**Status:** Phases 0–8 built and verified on synthetic data; Phase 9 adversarial testing in progress. Not deployed. Integrations with Gmail, HubSpot, Stripe and the AI model are built but **not yet verified against live accounts**; see `docs/plans/readiness-report.md` and `docs/plans/live-integration-runbook.md`. Clean-room rules apply (no copying of Bops).

## Run it locally

Needs Node 22+, pnpm 10, and PostgreSQL 16.

1. Start Postgres with `docker compose up -d` (creates the roles and databases on first start), or with your own Postgres 16 run `psql -U postgres -f scripts/setup-local-db.sql` once as a superuser. Local passwords only.
2. `cp .env.example apps/web/.env.local`, then set `BETTER_AUTH_SECRET` and `WOS_SECRETS_KEY`. For a demo without any external accounts, also set `WOS_MOCK_MODE=1`.
3. `pnpm install`
4. `DATABASE_URL_OWNER=postgres://wos_owner:owner_dev_pw@localhost:5432/wos_dev pnpm db:migrate`
5. Start the web app: `pnpm --filter @wos/web dev` → http://localhost:3000
6. Start the worker in a second terminal (same env vars): `pnpm --filter @wos/web worker`

On Windows, Docker works for step 1: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16`, then run the SQL with `psql -h localhost -U postgres`.

Demo seed (synthetic accounts only): from `apps/web`, `npx tsx e2e/demo-seed.ts`. Logins: `owner@e2e.test` / `sam@e2e.test`, password `e2e-password-12345`.

## Verified commands

`pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm test:isolation` · `pnpm build` · `pnpm test:e2e` (browser tests; uses an installed Chrome, `CHROME_PATH` to override)

Tests use the `TEST_DATABASE_URL` / `TEST_DATABASE_URL_OWNER` / `TEST_DATABASE_URL_ADMIN` triple (a separate database). `TEST_DATABASE_URL_ADMIN` is required by the front-desk and routine-reconciler tests — without it those tests fail with connection errors; see `.env.example` for what the admin role is for. E2E uses `E2E_DATABASE_URL` and `E2E_OWNER_DATABASE_URL`. On machines with ≤4 GB RAM, build with `npx next build --webpack` (the default Turbopack build can be OOM-killed there; both produce a working app).

## How it works

- Agents **propose** actions; the platform decides. Tier 0–1 run; tier 2 (external), 3 (financial) and 4 (destructive) wait in Approvals. What a person approves is fingerprinted, so any change to the action voids the approval. Email/chat-origin data forces tier ≥ 2. The lead bot is capped at tier 3. Tier 4 needs a second confirmation from a different owner.
- Scout finds roofing opportunities from attested prospect lists + NOAA SPC storm reports (CSV upload; live fetch not built). Consent and suppression are checked at send time.
- Each organization's data is isolated by Postgres row-level security. Tests discover every table and every API endpoint to prove it.
- Tasks run in a separate worker process via a Postgres-backed queue. Retries can't repeat a side effect: each step carries an idempotency key that the provider (or our records) can check.

## Layout

- `apps/web`: Next.js app (pages, API, auth), `worker.ts`, browser tests in `e2e/`
- `packages/db`: SQL migrations (RLS, grants), Drizzle schema, `withTenant` helpers
- `packages/core`: engine (tasks, policy, approvals, router), integrations, inbox/CRM/finance/memory/billing/Scout services
- `docs/`: research, design (ADRs, schema), plans (roadmap, acceptance evidence, readiness, runbook)
- `STATUS.md`: handoff status and release gate notes

## Working with agents

Rules live in `CLAUDE.md` / `.cursor/rules/`. Prompts in `prompts/`: milestone template, parallel delegation, drift guardrails.
