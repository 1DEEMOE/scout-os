# Readiness Report — MVP (Milestones 1–8)

Date: 2026-11-03. Status: **built and verified on synthetic data. Not deployed. Not production-ready.**
Deployment is stopped at the gate below, as the owner asked ("before deploying, approval required").

## What exists

| Area | State |
|---|---|
| Auth, orgs, roles | Email/password (Better Auth), owner/admin/member/viewer, membership management |
| Tenant isolation | Postgres RLS (forced) on all 21 tenant tables; non-owner app role; composite foreign keys; auto-discovered table and endpoint isolation tests |
| Task engine | 13-state machine with optimistic locking, durable queue (pg-boss), retries with backoff, crash reconciliation, escalation |
| Approvals | Tier 0–4 policy in code; approvals bound to an exact-action SHA-256 digest; single use; expiry; tier 4 second confirmation by an owner; enforced by DB constraints as well |
| Agents | Inbox, sales and finance presets; per-agent tool allowlists and tier ceilings; model router (Anthropic + MOCK) |
| Inbox | Gmail adapter, encrypted tokens, draft-first mode, thread-derived reply recipients, deterministic Message-IDs |
| Sales | HubSpot adapter: contacts, deals (tier 1), stage (tier 2), amount (tier 3), notes |
| Finance | Stripe Invoicing adapter: sync, overdue detection, reminders (tier 2), create/void (tier 3), integer cents |
| Memory | Org + working layers, trust levels, approval-gated agent facts, full-text recall, tenant-scoped |
| Billing | Per-call metering, monthly budget cap enforced before the call, Stripe Checkout, verified webhooks with replay protection, monthly usage ledger |
| UI | Overview, Approvals, Tasks, Inbox, Sales, Finance, Agents (+ memory), Audit log (+ CSV), Billing, Settings |

## Evidence

See `acceptance.md`. Summary of the final run: clean install, lint, typecheck, unit/integration tests, isolation suite, production build, and browser tests in Chrome all exit 0. Migrations apply cleanly to an empty database.

## Verified vs. unverified

| Verified here (real code paths) | Unverified (needs live accounts — see live-integration-runbook.md) |
|---|---|
| Postgres RLS, roles, grants, constraints | Gmail API calls (OAuth, sync, drafts, send) |
| Task engine, queue worker, crash retry (real pg-boss) | HubSpot API calls |
| Policy, approvals, digests, tier 4 confirmation | Stripe Invoicing API calls |
| Credential encryption and log redaction | Platform Stripe Checkout |
| Stripe webhook signature/replay checks (Stripe's own library, offline) | Anthropic model calls (planning quality, cost numbers) |
| Every API procedure refuses other tenants and signed-out callers | Behaviour under real load |
| UI flows in a real browser (MOCK tools) | Mobile layout beyond basic responsive checks |

## Known gaps (must be decided or fixed before real customers)

1. **Email verification and password reset** are not built (need a transactional email provider). Accounts are unverified.
2. **Auth rate limiting is in memory**: fine for one server, not shared across instances. Switch Better Auth to database storage before scaling out.
3. **Invitations** only add people who already have an account.
4. **Inbox sync is on demand** (button). No background polling or Gmail push yet.
5. **Single-shot planning**: an agent plans all actions up front and can't read a tool's result before deciding the next step. Multi-step reasoning needs separate tasks.
6. ~~Escalated tasks have no retry~~: done in Session 5 (managers can retry from the task page).
7. **Model prices** for metering are configuration (`MODEL_PRICE_*`); set them from the provider's price list.
8. **Data-processing review**: customer emails, CRM and invoice data are sent to the model provider (ip-flags #8). Gmail restricted-scope verification is required before public launch (ip-flags #5).
9. **Product name** customer-facing is **Scout OS**; internal identifiers remain wos/* / WOS_*. Trademark clearance for "Scout OS" is still required (ip-flags #1).

## Pre-deploy gate — owner approval required

Nothing below has been done. Each item needs your decision; several have cost impact.

1. **Hosting** (cost): a Node host for the web server *and* a separate always-on worker process. Options: Render, Fly.io, Railway, or a VPS. Vercel suits the web app but not the long-running worker on its own.
2. **Database** (cost): managed PostgreSQL 16 with daily backups and point-in-time recovery (Supabase, Neon, RDS, Render). Create the `wos_owner` and `app_user` roles as in `scripts/setup-local-db.sql`, with strong passwords.
3. **Secrets**: generate fresh `BETTER_AUTH_SECRET` (32+ random chars) and `WOS_SECRETS_KEY` (`openssl rand -base64 32`). Store in the host's secret manager. Losing `WOS_SECRETS_KEY` makes stored integration credentials unreadable; back it up separately.
4. **Environment**: `DATABASE_URL` (app_user), `DATABASE_URL_OWNER` (migrations only, not given to the running app), `BETTER_AUTH_URL`, `ANTHROPIC_API_KEY`, `MODEL_PRICE_*`, and the Google/Stripe variables when those integrations go live. `WOS_MOCK_MODE` must be unset.
5. **Release steps**: run migrations (`pnpm db:migrate` with the owner URL) → deploy web → deploy worker. Roll back by redeploying the previous build; migrations so far only add tables and columns.
6. **Live integration checks**: run `live-integration-runbook.md` against test accounts on a staging deployment first.
7. **Monitoring**: point `OTEL_EXPORTER_OTLP_ENDPOINT` at a collector; alert on error-level logs and on tasks stuck in RETRY_SCHEDULED/ESCALATED.

When you approve a hosting and database choice, the next session can prepare the deploy configuration and a staging release.
