# Scout OS — Phase 0: Discovery and Baseline Audit

Date: 2026-11-04. Repository: Workforce OS at commit `5ffbf78` (M12 + Session 5 review).
Method: read every migration, service, router and page; counted from the tree; ran the verified commands (results in H).
Roles below are run one after another by a single agent and labelled; no parallel or independent review is claimed here (the independent audit is Phase 9).

## A. Existing architecture report — *Principal Software Architect*

| Layer | What exists | Evidence |
|---|---|---|
| Monorepo | pnpm workspaces: `apps/web`, `packages/core`, `packages/db` | `pnpm-workspace.yaml` |
| Frontend | Next.js 16 App Router, React 19, Tailwind 4, server components + small client components (`actions.tsx`, `auto-refresh.tsx`) | `apps/web/src/app` (53 files, ~2.1k lines) |
| API | tRPC 11 with superjson; 44 procedures across 12 routers; typed `AppError` → tRPC codes | `apps/web/src/server/routers`, `trpc.ts` |
| Business logic | `packages/core` (~4.1k lines): engine, integrations, inbox/crm/finance/memory/billing/chat services | `packages/core/src` |
| Database | PostgreSQL 16, 29 tables, 9 SQL migrations, Drizzle for typed queries | `packages/db/migrations` |
| Auth | Better Auth, email + password, sessions in Postgres, in-memory rate limit | `apps/web/src/server/auth.ts`, ADR-003 |
| Workers | Separate `worker.ts` process; pg-boss queue in Postgres; maintenance loop re-queues crashed jobs | ADR-001, `engine/queue.ts` |
| Observability | pino structured logs with secret redaction; OpenTelemetry spans (export only when an endpoint is set) | `logger.ts`, `tracing.ts`, `instrumentation.ts` |
| Deployment | **None.** CI workflow file exists, never run. No hosting config. | `.github/workflows/ci.yml` |

## B. Agent capability inventory — *AI Systems / Orchestration Engineer*

Agents are DB rows (`agents`, immutable `agent_versions`, `agent_permissions`), one per kind per org. Allowed kinds (DB check): orchestrator, inbox, sales, finance, scheduling, reporting. Presets exist for inbox, sales, finance. A lead bot (chat) delegates to presets.

| Directive role | Existing equivalent | Gap |
|---|---|---|
| SCOUT | none | New: kind, tools, data |
| INBOX | `inbox` agent: categorize (T1), draft (T1), send draft (T2) | Replies to existing threads only; no new outbound |
| PIPELINE | `sales` agent: contact (T1), deal (T1), note (T1), stage (T2), amount (T3) | Reuse; display name |
| FOLLOW-UP | none (drafting lives in inbox) | Logical role on top of inbox drafts + consent gate |
| BILLING | `finance` agent: reminder (T2), create/void invoice (T3) | Reuse; display name |
| ANALYST | `reporting` kind allowed, no preset or tools | Funnel analytics is a service, not an agent, in this phase |
| COORDINATOR | lead bot (chat) + orchestrator state machine | Reuse; display name |

Agent safeguards present: allowlist + per-tool tier ceiling; policy in code (tiers 0–4); approval bound to SHA-256 action digest; single-use, expiring approvals; tier 4 second confirmation by a different owner (G1); no self-approval (G2); delegated grant = min(agent, lead ceiling 3, requester role) (G3); values copied from external text force approval (G7); kill switch; budget cap before each model call.

## C. Database and tenant isolation map — *Security and Privacy Engineer*

- 25 tenant tables, all with `tenant_id`, RLS **enabled and forced**, policy `tenant_id = app_current_tenant()`; composite FKs `(tenant_id, parent_id)`.
- App role `app_user`: no superuser, no BYPASSRLS, owns nothing. Owner role used only by migrations.
- Context set per transaction (`set_config(..., true)`); proven not to leak through the pool.
- Global tables: users, 3 auth tables, webhook_events, schema_migrations, pgboss.*.
- Tests: `packages/db/test/isolation.test.ts` discovers every `tenant_id` table and fails if one is unprotected or unseeded; `apps/web/test/all-endpoints-isolation.test.ts` discovers every API procedure and probes it as another org's owner and signed out.

## D. Integration inventory — *Lead Intelligence / Data Engineer*

| Integration | Status | Notes |
|---|---|---|
| Anthropic (model router) | Built, **UNVERIFIED** live | MOCK provider used in tests |
| Gmail | Built, **UNVERIFIED** live | Restricted scopes need Google verification |
| HubSpot | Built, **UNVERIFIED** live | Needs `wos_idempotency_key` properties |
| Stripe Invoicing (tenant) | Built, **UNVERIFIED** live | |
| Stripe Billing (platform) | Webhooks verified offline with Stripe's library; checkout **UNVERIFIED** | Not tied to feature access (see E-1) |
| Lead / property / weather data | **None** | Needed for Scout |

## E. Security findings — *Security and Privacy Engineer*

| # | Finding | Severity | Plan |
|---|---|---|---|
| E-1 | Subscription status grants nothing and removes nothing: every org can use every feature regardless of plan, trial or cancellation. `organizations.plan` is never read. | **High** for a paid product (blocks release per directive §17) | Phase 3: server-side entitlements |
| E-2 | No HTTP security headers. The approval page can be framed by another site (clickjacking on Approve buttons); no `nosniff`, no referrer policy. | **High** | Phase 2: headers in `next.config.ts` + test |
| E-3 | Audit events are deleted with their organization (`ON DELETE CASCADE`). No org deletion path exists yet, so not exploitable today. | Medium | Documented; retention design in Phase 1 |
| E-4 | Members can request tier-3 work from the Tasks page, while chat caps members at tier 2 (a manager still approves either way). | Low | Owner decision (open since Session 5) |
| E-5 | Account enumeration: the invite form tells managers whether an email has an account. | Low | Accept for now; revisit with email invitations |
| E-6 | Auth rate limit is per process (in memory). | Medium at scale | Before multi-instance deploy |
| E-7 | No data retention or deletion policy for prospect or communication data. | **High once Scout stores prospect data** | Phase 4: retention fields + purge job |
| E-8 | No consent, suppression or opt-out model. Harmless today (no outbound to new contacts exists); required before any prospect outreach. | **Blocking for Scout outreach** | Phase 4/6 |

CSRF: session cookies are `SameSite=Lax`, so cross-site POSTs carry no session; tRPC mutations are POST only. Verified in Phase 9.

## F. Reuse versus build matrix — *Principal Software Architect*

| Need | Decision | Why |
|---|---|---|
| Agents, permissions, tiers, approvals, queue, audit | **Reuse** | Tested, enforced in code and DB |
| CRM records for handed-off leads | **Reuse** `contacts` / `crm_records` and `crm.*` tools | Avoid a parallel CRM |
| Subscriptions table and Stripe webhooks | **Reuse**, extend with plan resolution | |
| Usage metering | **Reuse** `usage_events` for cost; **build** quota counters (atomic) | `usage_events` is append-only, can't enforce limits without races |
| Agent roster | **Extend**: add `scout` kind; map other directive roles to existing kinds by display name | Directive: no separate infra per agent |
| Business profile, sources, signals, prospects, opportunities, consent, suppression | **Build** | Nothing equivalent exists |
| Storm data adapter | **Build** behind an interface | First vertical |
| Analytics funnel | **Build** as a service over existing tables + new ones | |
| Map view | **Not built** | Directive §13: no decorative maps; a county/state table shows real data |

## G. Implementation dependency graph

```
P2 rebrand + headers ─┐
P3 entitlements ──────┼─► P4 Scout schema ─► P5 roofing adapter + matching + scoring ─► P6 Scout agent + handoff (+ consent gate)
                      │                                                                     │
                      └──────────────────────────────────────────────────────────► P7 dashboard ─► P8 lifecycle + analytics ─► P9 adversarial + independent audit
P10–P12 need: hosting decision, real accounts, compliance review, owner approval  ──► NO-GO until then
```

## H. Baseline test results

Recorded in `docs/plans/acceptance.md` (Scout Phase 0 section) from this session's run.

## Assumptions (to confirm)

1. "Scout OS" is approved as the customer-facing name by the owner (the directive says so). Trademark check still open (ip-flags #1).
2. Prospects come only from the customer's own CRM and from lists the customer imports with a declared source and usage rights. No scraping, no purchased data without a license on file.
3. Storm signals come from NOAA Storm Prediction Center local storm reports (US government work, public domain). Live retrieval is **UNVERIFIED** from this environment (network allowlist).
4. Plan names (Starter, Growth, Scout Pro, Enterprise) are hypotheses; no prices are set in code.
5. Outreach to non-consented prospects is out of scope; the system blocks it.
