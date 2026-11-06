# MVP Roadmap (PROPOSAL, awaiting approval)

Each milestone is ≤ 3 days of agent work, independently testable, and ordered by dependency.
All acceptance runs use synthetic data and sandbox/test keys.

**One deviation from the brief:** the approval *engine* (policy, approval_requests, executor gate) moves into Milestone 2, because Milestones 3–5 can't send anything safely without it. Milestone 6 keeps the approval center and audit *UI*.

| # | Milestone | Status |
|---|---|---|
| 1 | Auth + org onboarding with proven tenant isolation | **Done — awaiting owner review** (Session 2) |
| 2 | Agent registry, orchestrator state machine, policy + approval engine | Done (Session 3) |
| 3 | Inbox specialist + Gmail (draft-first) | Done (Session 3) — Gmail adapter unverified live |
| 4 | Sales/CRM specialist + HubSpot | Done (Session 3) — HubSpot adapter unverified live |
| 5 | Finance specialist + one invoicing integration | Done (Session 3) — Stripe adapter unverified live |
| 6 | Approval center + audit log UI | Done (Session 3) — 4 browser tests pass in Chrome |
| 7 | Tenant-isolated memory (working + org layers) | Done (Session 3) |
| 8 | Command dashboard + usage metering + Stripe billing | Done (Session 3) — platform Stripe unverified live |

Deferred: phone/SMS, white-label, dedicated per-agent computers, computer use generally.

---

## M1 — Auth + organization onboarding

- **Deliverables:** pnpm monorepo (`apps/web`, `packages/db`, `packages/core`), Next.js app, auth (library chosen by ADR), sign-up → create org → invite member, Drizzle schema for users / organizations / organization_members / audit_events, RLS policies, `withTenant()` helper, pino logging, OTel bootstrap, CI script.
- **Contracts:** `org.create({name}) → {orgId}`, `org.invite({email, role})`, `org.listMembers()`; `withTenant(tenantId, fn)`.
- **Tests:** RLS test as `app_user` (tenant A sees zero B rows on every table); role checks on invite; audit row on each mutation.
- **Acceptance:** `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass; `pnpm test:isolation` output lists every tenant table with 0 cross-tenant rows.

## M2 — Agent registry, orchestrator, policy + approvals

- **Deliverables:** agents / agent_versions / agent_permissions / tasks / task_dependencies / workflow_executions / approval_requests tables; `transition()` with optimistic locking; pg-boss worker; policy engine with tiers 0–4; executor gate with action digests; model router interface with one real provider and a labelled MOCK provider for tests.
- **Contracts:** `task.create({intent, input}) → {taskId}`; `transition(taskId, from, to)`; `executor.propose({agentId, tool, args}) → {status: 'executed' | 'pending_approval', approvalId?}`; `approval.decide({approvalId, decision})`.
- **Tests:** every legal and illegal state transition; worker killed mid-step resumes without duplicate side effect; tier 2 proposal never executes without approval; approval with changed args is refused; expired and reused approvals refused; tenant isolation on all new tables.
- **Acceptance:** scripted run: create task → orchestrator plans → mock tool at tier 2 → approval → execute → COMPLETED, printing the audit trail.

## M3 — Inbox specialist + Gmail (draft-first)

- **Deliverables:** Google OAuth connection (test Google account), encrypted token storage, Gmail read + draft creation (tier 1), send (tier 2, approval required), conversations / messages / email_identities tables, push or polling sync with replay protection.
- **Contracts:** `inbox.sync(connectionId)`, `inbox.triage(conversationId) → {category, summary, proposedDraft}`, `inbox.createDraft(...)`, `inbox.send(draftId)` (tier 2).
- **Tests:** prompt-injection fixture (email instructing the agent to forward data) produces no send and no new recipient; tokens never appear in logs (log-scan test); duplicate webhook ignored.
- **Acceptance:** on a sandbox inbox, 10 synthetic emails → triaged → drafts visible in Gmail Drafts; one send goes through approval; audit trail printed.

## M4 — Sales/CRM specialist + HubSpot

- **Deliverables:** HubSpot developer test account connection; contacts / crm_records tables; read deals and contacts (tier 0), create notes and tasks (tier 1), stage changes (tier 2).
- **Tests:** idempotent upsert on retry; field-level permission (agent can't change amounts without tier 3); isolation.
- **Acceptance:** inbox lead email → contact + deal created in the HubSpot test portal → follow-up draft queued for approval.

## M5 — Finance specialist + invoicing

- **Deliverables:** one invoicing integration (**DECISION:** Stripe Invoicing test mode recommended — already in the stack; QuickBooks sandbox as alternative); invoices table; overdue detection; reminder drafts (tier 2); create/void invoices (tier 3).
- **Tests:** tier 3 cannot be auto-approved by any policy setting; amounts stored in integer cents; idempotent invoice creation.
- **Acceptance:** synthetic overdue invoices → reminders drafted → one approved and sent in test mode → ledger and audit rows printed.

## M6 — Approval center + audit log UI

- **Deliverables:** approvals inbox (diff of exact action, approve/reject, tier 4 second confirmation), audit log viewer with filters and CSV export.
- **Tests:** Playwright e2e for approve/reject; viewer role can't approve; UI shows MOCK labels where relevant.
- **Acceptance:** e2e suite green; screenshots of approval and audit screens attached to session log.

## M7 — Tenant-isolated memory

- **Deliverables:** memory_records with working and org layers; Postgres full-text retrieval first (pgvector later via ADR); trust levels; user view/delete UI.
- **Tests:** retrieval never returns another tenant's memory; agent-written memory can't change permissions or payment details; poisoning fixture.
- **Acceptance:** agent recalls an org fact across two tasks; deleted memory no longer retrieved.

## M8 — Dashboard, metering, Stripe billing

- **Deliverables:** command dashboard (active tasks, pending approvals, spend); usage_events from router and executor; budget caps; Stripe Billing test mode subscriptions; billing_ledger; webhook handling.
- **Tests:** webhook signature and replay tests; budget cap halts a task; ledger reconciles with usage.
- **Acceptance:** test-mode subscription created, usage recorded, cap enforced, webhook replays rejected; full verified command suite green.

Pricing numbers for plans are an owner decision before M8.
