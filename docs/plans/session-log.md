# Session Log

## Session 0 — Setup (2026-11-03)
- Repo scaffold created from AD22 OMEGA v2.
- CLAUDE.md and .cursor/rules/workforce-os.mdc hold identical rules (Part A) plus an REA usage boundary.
- Verified commands still `<FILL_IN>`; proposed in Session 1.

## Session 1 — Kickoff (2026-11-03)

Run in a Claude cloud workspace, not in Claude Code or Cursor. No product code written.

### Verified (with how)
- Toolchain: `node --version` (v22.23.4), `pnpm --version` (10.28.0), `psql --version` (16.15), npm registry reachable (HTTP 200).
- Not available here: Postgres server (`pg_isready` no response), Docker daemon (`docker info` failed).
- REA MCP on the owner's desktop: `get_device_info` → `announced`; `list_documents` → "no app open". Not used for research.
- Dependency licenses: `npm view <pkg> version license` for 22 packages → license-register.md.
- Bops facts: public README via raw.githubusercontent.com, EveryDev and Composio listings.

### Not verified
- bops.bot and github.com/OrgoAI/bops pages (blocked from this session); Bops LICENSE file text.
- Lindy and Relevance AI computer use, memory, approvals, white-label; their scores are judgments, marked `?` where no evidence.
- Bops plan details conflict between sources (computers on Max, free-tier hours).

### Artifacts
- docs/research/capability-matrix.md, competitive-intelligence.md, license-register.md, ip-flags.md
- docs/design/architecture-v1.md, orchestration-adr.md, computer-use-adr.md
- docs/plans/mvp-roadmap.md

### Open questions for the owner
1. Approve pg-boss over Temporal for the MVP?
2. Approve moving the approval engine into M2 (UI stays in M6)?
3. Target segment: small professional-service firms, with your tax practice as design partner on synthetic data?
4. Dev database for M1: Docker Postgres on your machine, a Supabase branch, or a local install?
5. Auth library: Auth.js v5, Better Auth or Supabase Auth? (ADR in M1 either way.)
6. Invoicing for M5: Stripe Invoicing (recommended) or QuickBooks sandbox?
7. Product name: keep "Workforce OS" as a working title until a trademark check?
8. Approve the proposed verified commands (`pnpm install`, `pnpm test`, `pnpm lint && pnpm typecheck`, `pnpm build`)?

### Recommended first milestone
**M1 — Auth + organization onboarding with proven tenant isolation.** Everything else depends on `withTenant()` and RLS being right.

### STOP
Waiting for approval of architecture-v1 and mvp-roadmap before any implementation.

## Session 2 — Milestone 1: Auth + organization onboarding (2026-11-03)

Owner said "move to phase 2". Taken as approval of architecture-v1 and the roadmap, with my recommended answers to the open questions:
pg-boss (not used yet), local Postgres for dev, Better Auth, the pnpm commands. Each is reversible; flag any you disagree with.

### What works
- pnpm monorepo: `apps/web` (Next.js 16), `packages/db` (schema, migrations, RLS, context helpers), `packages/core` (org service, audit, logging, tracing).
- Sign-up / sign-in (email + password), create organization, add an existing user with a role, list members, list my organizations.
- Postgres RLS, enabled and forced, on organizations, organization_members, audit_events. App runs as `app_user` (no BYPASSRLS, owns nothing).
- `withTenant` / `withUser` / `withGlobal` are the only ways to query; ESLint blocks raw `pg` imports outside packages/db (rule verified to fire).
- Audit events for create, invite and denials (denials committed in their own transaction so they survive the rollback). Audit log is append-only for the app.
- Typed errors mapped to tRPC codes; unknown errors logged and shown as a generic message with a reference id. Non-member probes logged.
- CI workflow (GitHub Actions) running the full suite against Postgres 16. **Not run yet** (repo isn't on GitHub).

### Verified (how)
Full suite, all exit 0: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (30 tests), `pnpm test:isolation` (12 tests), `pnpm build`.
HTTP acceptance script: 15/15 checks passed against `next start`. Details and outputs in docs/plans/acceptance.md.

### What is mocked
Nothing. No external integrations exist yet.

### Deviations from the plan, and why
1. **Three tables added beyond the approved list:** `auth_sessions`, `auth_accounts`, `auth_verifications`. Any auth needs session and credential storage. Global, no tenant data. See auth-adr.md.
2. **"Invite" adds existing accounts only.** Pending invitations for people without an account need an invitations table, which isn't on the approved list, plus an email sender (Milestone 3). The UI says so plainly. Owner decision: add an `organization_invitations` table now, or wait for M3?
3. **TypeScript 6.0.3, not 7.0.2.** typescript-eslint doesn't support TS 7 yet.
4. **@opentelemetry/api pinned to 1.9.1** via workspace override: 1.10 is outside the peer range of @vercel/otel, tRPC and Next.
5. **Relative imports have no `.js` suffix.** Next's Turbopack couldn't resolve `.js` → `.ts` across workspace packages.

### Known gaps (not blockers for M1)
- No browser-level UI test (Playwright is planned for M6). Pages verified by HTTP status and redirects only.
- Email verification and password reset deferred to M3 (needs a mail sender).
- Better Auth's sign-up rate limit is in memory; it resets on restart and isn't shared across instances. Needs Postgres- or Redis-backed storage before more than one instance runs.
- Transitive deprecation warning from @vercel/otel (sdk-trace-base 2.12). No action needed now.

### Next step
Owner reviews M1. Then Milestone 2: agent registry, orchestrator state machine, policy + approval engine.

### STOP
Waiting for review of Milestone 1 before starting Milestone 2.

## Session 3 — Milestones 2–8, run to completion (2026-11-03)

Owner asked to loop through all milestones without stopping at each gate, and to stop before deploying. Done. **Nothing has been deployed.**

### What was built
- M2: agent registry, 13-state task machine (optimistic locking), pg-boss worker, tier 0–4 policy in code, approvals bound to exact-action digests (single use, expiry, tier 4 confirmation, DB constraints), model router (Anthropic + MOCK).
- M3: encrypted credentials, Gmail adapter + OAuth with signed state, sync, triage, draft-first sending with thread-derived recipients.
- M4: HubSpot adapter; contacts and deals; stage tier 2, amount tier 3.
- M5: Stripe Invoicing adapter; overdue detection; reminders tier 2; create/void tier 3.
- M6: approval center, audit log + CSV, and working pages for every area; browser tests in Chrome.
- M7: org/working memory with trust levels; agent facts need approval; recall in planning.
- M8: metering, budget cap enforced before each model call, Stripe Checkout, verified webhooks with replay protection, usage ledger, dashboard.

### Verified (how)
Clean install → lint, typecheck, 205 tests, 15 isolation tests, build, 5 browser tests: all exit 0. Migrations apply to an empty DB. Acceptance scripts M1–M3 rerun on the final code. Details: acceptance.md.

### What is mocked or unverified
Tests use MOCK mailbox, CRM, invoicing and model providers (labelled MOCK in code and UI). Gmail, HubSpot, Stripe and Anthropic adapters are **unverified against live services**: request shapes are unit-tested with stubbed clients only. Runbook: live-integration-runbook.md.

### Deviations, and why
1. Tables added beyond the approved list: `webhook_events` (replay protection, global). Earlier: three auth tables.
2. Credentials stored as AES-GCM ciphertext in `integration_connections` instead of a separate secrets service.
3. "Direct plans" for server-initiated actions (e.g. send this draft); they still need policy and approval.
4. Memory tools (`memory.note`, `memory.propose_fact`) were added to the presets.
5. Queue job expiry lowered to 300 s, and maintenance enabled in the worker. Without it, a crashed worker's job would not be retried; verified by a new test.

### Found and fixed along the way
- Retries after a dropped connection weren't reconciling (the earlier attempt was marked failed, not running). Retries now always reconcile first.
- A waiting task holding an already-used approval sat forever; it now fails.
- Tool schemas with value transforms couldn't be described to the model; fixed and covered by a test.
- Approval audit entries could be lost on rollback; denials are now committed separately.

### Open decisions for the owner
See readiness-report.md "Known gaps" and "Pre-deploy gate": hosting and database choice (cost), email provider for verification/reset, plan pricing (STRIPE_PRICE_ID), model price settings, invitation flow, and the live integration checks.

### STOP
Waiting for the owner's approval before any deployment.


## Session 4 — M12 lead bot chat (2026-11-04)

Branch `feat/m12-lead-bot-chat` (from `fix/demo-seed-types`). Local commits only; nothing pushed or deployed.

### Built
- Migration 0008: `chat_threads`, `chat_messages`, `chat_delegations` (RLS enabled + forced, minimal grants), client-ref dedupe, distinct-confirmer check on `approval_requests`.
- `packages/core/src/chat`: thread/message service and lead bot delegation into the existing engine; MOCK keyword lead planner (replies start "MOCK lead bot:") used under WOS_MOCK_MODE=1 and in tests.
- Web: `chat` tRPC router, Chat nav item, thread list and thread pages (MOCK badge on mock replies).
- Safety (risk checklist G1, G2, G3, G7): see schema.md "Lead bot delegation". `expireDue` now filters by tenant explicitly.

### Verified (how)
`chat.test.ts` (25 tests) covers delegation, role intersection, chain id in digest, fan-out caps, G1, G2, G7 taint/injection, TC-07, TC-09, TC-12 (double send), expireDue cross-org. Isolation tests seed the new tables. All five checks run locally; results in the M12 report.

### Behaviour changes
- G2 changed existing tests: approvals of a task the owner requested are now made by `admin` in the harness.
- G7 applies to every task (owner decision): CRM steps that use an email sender's address wait for approval. The CRM test and demo seed approve them.
- Kept by owner decision: the audited sole-manager self-approval waiver, and the lead bot ceiling of tier 3.

### Mocked or unverified
- The real-model lead bot flow (TC-01/TC-02) is **unverified**: only the MOCK planner ran.
- No live refresh of task states on the thread page (TC-16); no latency measurement (TC-15); sub-agent results aren't fed back to the lead bot.

### Follow-ups
G4 audit hash chain and the cascade that deletes audit rows with the org; retention; kill switch; rate limits on chat sends; G8 PII redaction in logs.

## Session 5 — Review and enhancement of the M12 build (2026-11-04)

Input: `workforce-os-demo.zip` (feat/m12-lead-bot-chat @ 691dab7), no git history, so it was committed as a baseline first. Received build verified green before changes (lint, typecheck, 238 tests, 15 isolation tests). Every screen was then driven in Chrome as owner, member and on a phone (390 px) with the demo seed. Before/after screenshots: `docs/plans/evidence/session5/`.

### Found, by law
- **Law 2 (no fabricated functionality):** tasks that finished with zero actions showed a green "completed", including chat hand-offs in MOCK mode, which read as "the reminders were sent". Overview counted them as completed work.
- **Law 4 (attributable, reviewable external actions):** approval cards named records by id ("invoice bfecc9f2", "deal ef86ee4b"); they didn't say who asked, that the work came from chat, or that a step was forced to approval because an address came from external text (G7).
- **G1/G2 rules without UI:** the requester and the first tier-4 approver were still shown Approve / Confirm buttons that then failed. In a one-owner org a tier-4 action can never be confirmed, and nothing said so.
- **E2E test broken by G1:** the tier-4 browser test approved and confirmed as the same owner, so it could no longer pass. The seed had one owner only.
- **Legibility:** task names were the agent's raw instructions; delegated tasks were titled "Request from the business user: …" (MOCK planner bug).
- **Chat:** every person's messages were labelled "You"; "Start" didn't open the thread; the UI sent no client reference (double-send dedupe unused); progress needed manual refresh; an unknown thread id gave a server error instead of 404.
- **Phone:** the audit table squashed into a ~26,000 px page; long action names overflowed approval cards.
- **Bug found while testing:** a rate-limit denial written in the same transaction it then rolled back would have vanished from the audit log.

### Changed
- Migration 0009 (additive, with rollback SQL): `tasks.title`, org kill-switch columns.
- Core: `taskLabel`, `finishedWithoutActions`, `approvalsForReview` (record context, headline with names, G7 fields, chat origin, per-viewer rules), `setAgentsPaused`/`getPauseState` honoured by the engine (also between actions mid-plan) and the lead bot, chat rate limit (10/min/person, denial audited in its own transaction), author names in threads, `retryEscalatedTask`, human titles for server-created tasks, MOCK planner prefix fix.
- API: `agent.pauseState`, `agent.setPaused`, `task.retry` (covered by the all-endpoints isolation test).
- UI: rebuilt Approvals; honest task status everywhere; Retry on escalated tasks; chat author names, open-on-start, client refs, auto-refresh while hand-offs run, 404; pause banner and owner switch in Settings; phone fixes.

### Verified (how)
Clean install, then `pnpm lint`, `pnpm typecheck`, `pnpm test` (21 files, 263 tests), `pnpm test:isolation` (15), `pnpm build`, `pnpm test:e2e` (8 browser tests in Chrome): all exit 0. Outputs in acceptance.md.

### Not done / still open
- Real-model lead bot flow remains unverified (MOCK only), as before.
- Members can still create tier-3 work through the Tasks page (it waits for a manager's approval), while chat caps members at tier 2. Owner decision: apply the role ceiling to all tasks?
- One-owner orgs can't complete tier-4 actions under G1. The UI now says so. Owner decision: keep, or allow an audited exception like G2's sole-manager waiver?
- G4 audit hash chain, retention, G8 PII redaction: still open.

### STOP
Nothing deployed. Waiting for review.

## Session 6 — Scout OS (2026-11-04)

Directive: Scout OS Master Engineering Directive v1.0. Phases 0–9 executed; 10–12 are release gates (NO-GO, see final report).

Commits: Phase 0–1 docs; b2a3d1b rebrand + headers; d1e4107 entitlements; 3e0d96f data model + roofing + scoring; 6792ffa orchestration + consent gate; fb359a4 dashboard + analytics; f52c32d adversarial tests.

State: 25+ test files, all green at each commit (see acceptance.md for exact counts and commands). Independent audit running in Phase 9 (fresh agent, read-only); remediation follows its report.

Next step if context runs out: read the audit report in the final engineering report (`docs/plans/scout-final-report.md`), fix Critical/High findings with tests, re-run the verified commands, package the zip.

## Session 7 — Wave 1 trust + correctness hardening (2026-11-06)

Directive: independent audit (docs/plans/audit-2026-11-06.md, overall 6/10) → fix weaknesses in wave order. User approved "everything, in wave order". Wave 1 = C6 → C2 → C4 → C5 → C3 → H2 → H4 → H5 → H1 → H3 → H6.

### Changed
- Migration 0018 (+ rollback): organization_invitations (SHA-256 token only, 7-day TTL, partial unique pending index, forced RLS); audit_events hash-chain columns + shape check; DELETE grants on integration_connections/email_identities; front_desk_channels token_hash (RLS-safe md5-based one-time backfill — embedded Postgres has no pgcrypto — plaintext dropped, unique index); job_photos UPDATE restricted to integrity columns.
- Core: audit hash chain (advisory-lock serialized recordAudit, entryHashOf, verifyAuditChain); deep PII scrubber in logger; org invitations + removeMember + setMemberRole (last-owner and staff-protection rules, seats checked at add AND accept); engine task.cancel (requester or manager, pending approvals expired with audit), 30/hour task-create cap, FAILED transitions from active states; approval-expiry wake-up job (ttl+60s); front-desk atomic slot hold + atomic rate buckets + hashed bearer tokens + lazy expiry of stale bookings; background inbox sync chain (inbox.sync queue, singleton per mailbox, stops on disconnect); disconnectIntegration; optional OTel SDK (no-op without endpoint).
- Web: org router (invitations, member management), integration router (list/disconnect), task.cancel + audit.verifyChain procedures; settings page (role change, remove, invitations card, disconnect); invite form (member vs emailed-link result); /accept-invite page; sign-in/up honor ?next= (same-site only); task cancel button; audit chain badge; members table wrapped for phone widths.
- Docs: README + .env.example document DATABASE_URL_ADMIN / TEST_DATABASE_URL_ADMIN / E2E_* / WOS_INBOX_SYNC_SECONDS (C6); license register adds @opentelemetry/sdk-node (Apache-2.0).
- Tests: 5 new files (org-membership 14, audit-chain 6, engine-cancel 7, inbox-sync 4, logger PII), endpoint-isolation registry updated (org.acceptInvitation is intentionally not org-scoped; token + email match is the gate), isolation seeds for the two new/changed tables, CSV header expectations include chain columns, e2e invite flow uses the new Invite button.

### Verified (how)
`pnpm lint` · `pnpm typecheck` · `pnpm test` (42 files, 565 tests) · `pnpm test:isolation` (15) · `npx next build --webpack` (Turbopack build OOM-killed on this ≤4 GB sandbox; webpack build is the documented fallback) · `pnpm test:e2e` (20 browser tests). Deviations from the shipped state: the 2 pre-existing lint errors were fixed (forgery.ts unused import, job-photos useless assignment).

### Not done / still open
- Waves 2–3 (front-desk public booking page + settings UI, speed-to-lead autopilot, chat-as-OS tools, trust pages, nurture routines): designed in the audit doc, not built in this session.
- Pricing/packaging numbers: owner decision per project rules.
- Turbopack production build on low-memory machines (works on normal dev machines; untracked upstream).
