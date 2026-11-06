# Acceptance Evidence

Per CLAUDE.md law 6, nothing is production-ready without evidence here. This file records per-milestone acceptance runs. **It is development evidence on synthetic data, not a production-readiness sign-off.**

## Final verification — 2026-11-03 (Session 3, Milestones 1–8)

Environment: Claude cloud workspace, Node 22.23.4, pnpm 10.28.0, PostgreSQL 16.15, Chrome (system install) for browser tests. **Development evidence on synthetic data and MOCK providers, not a production-readiness sign-off** (see readiness-report.md).

### Full suite from a clean install (node_modules and build output deleted first)

```
### exit=0 :: pnpm install --frozen-lockfile
### exit=0 :: pnpm lint
### exit=0 :: pnpm typecheck
### exit=0 :: pnpm test
### exit=0 :: pnpm test:isolation
### exit=0 :: pnpm build
### exit=0 :: pnpm test:e2e
```

```
 Test Files  19 passed (19)
      Tests  205 passed (205)
 Test Files  1 passed (1)
      Tests  15 passed (15)
  5 passed (17.7s)
```

- `pnpm test`: 19 files, 205 tests, covering engine, policy, approvals, inbox, CRM, finance, memory, billing, workers, API routes. It includes an auto-discovered check that **all 37 API procedures** refuse another org's owner and a signed-out caller.
- `pnpm test:isolation`: 15 tests across all 21 tenant tables (report below).
- `pnpm test:e2e`: 5 browser tests in Chrome against the production build plus a real worker process (approval center, tier 4 confirmation, audit log and CSV, every page renders). Screenshots in `evidence/`.

### Tenant isolation report

```
Tenant isolation report (querying as tenant A, app_user):
organizations          tenant A rows=1  tenant B rows visible=0
agent_permissions      tenant A rows=1  tenant B rows visible=0
agent_versions         tenant A rows=1  tenant B rows visible=0
agents                 tenant A rows=1  tenant B rows visible=0
approval_requests      tenant A rows=1  tenant B rows visible=0
audit_events           tenant A rows=1  tenant B rows visible=0
billing_ledger         tenant A rows=1  tenant B rows visible=0
contacts               tenant A rows=1  tenant B rows visible=0
conversations          tenant A rows=1  tenant B rows visible=0
crm_records            tenant A rows=1  tenant B rows visible=0
email_identities       tenant A rows=1  tenant B rows visible=0
integration_connections tenant A rows=1  tenant B rows visible=0
invoices               tenant A rows=1  tenant B rows visible=0
memory_records         tenant A rows=1  tenant B rows visible=0
messages               tenant A rows=1  tenant B rows visible=0
organization_members   tenant A rows=1  tenant B rows visible=0
subscriptions          tenant A rows=1  tenant B rows visible=0
task_dependencies      tenant A rows=1  tenant B rows visible=0
tasks                  tenant A rows=2  tenant B rows visible=0
usage_events           tenant A rows=1  tenant B rows visible=0
workflow_executions    tenant A rows=1  tenant B rows visible=0
```

Negative controls: disabling RLS on one table made 5 isolation tests fail (Session 2). A new table without RLS or a seed row fails the suite by design.

### Migrations on an empty database

All 7 migrations applied in order to a fresh database. Tables without forced RLS: exactly `users`, `auth_accounts`, `auth_sessions`, `auth_verifications`, `webhook_events`, `schema_migrations` (global, no tenant data).

### Queue durability (real pg-boss, app role)

A job taken by a worker that then "died" was moved back to `retry` by the maintenance loop running as `app_user` (test in `packages/core/test/worker.test.ts`). A provider call that succeeded before the connection dropped was found on retry by its idempotency key, so there was one effect, not two (engine, inbox, CRM tests).

### M1 — HTTP acceptance (`scripts/acceptance-m1.sh` against `next start`)

```
== Sign up three synthetic users
PASS  owner sign-up
PASS  staff sign-up
PASS  other-firm sign-up
== Create organizations
org A=<uuid>  org C=<uuid>
== Invite and list
PASS  owner adds staff as member
PASS  org A has 2 members
PASS  staff sees org A in their list
== Authorization
PASS  member cannot invite
PASS  anonymous request rejected
== Tenant isolation
PASS  org C owner cannot list org A
PASS  org C owner cannot invite into org A
PASS  org C owner sees only org C
== Pages
PASS  org page renders for owner
PASS  org page is 404 for other tenant
PASS  signed-out visitor redirected to sign-in
ALL ACCEPTANCE CHECKS PASSED
```

### M2 — task through approval with the real worker (`packages/core/scripts/acceptance-m2.ts`, MOCK model and tools)

```
<claude-code-hint v="1" type="plugin" value="stripe@claude-plugins-official" />
waiting for approval; external calls so far: 0
approval request: "Email client@example.test: Re: invoice" (tier 2, digest ad0a4e39bb54...)
task COMPLETED; MOCK external effects: 2

Audit trail:
  user    org.create             tier 1  success
  user    agent.create           tier 4  success
  user    task.create            tier 1  success
  system  task.transition        tier 0  success  REQUESTED -> CLASSIFIED
  system  task.transition        tier 0  success  CLASSIFIED -> PLANNED
  system  task.transition        tier 0  success  PLANNED -> POLICY_CHECKED
  system  task.transition        tier 0  success  POLICY_CHECKED -> WAITING_FOR_APPROVAL
  agent   approval.request       tier 2  success
  user    approval.approve       tier 2  success
  system  task.transition        tier 0  success  WAITING_FOR_APPROVAL -> ASSIGNED
  system  task.transition        tier 0  success  ASSIGNED -> EXECUTING
  agent   tool.mock.lookup       tier 0  success
  system  approval.consume       tier 2  success
  agent   tool.mock.send_email   tier 2  success
  system  task.transition        tier 0  success  EXECUTING -> VERIFYING
  system  task.transition        tier 0  success  VERIFYING -> COMPLETED
```

### M3 — inbox: 10 synthetic emails, MOCK mailbox (`packages/core/scripts/acceptance-m3.ts`)

```
<claude-code-hint v="1" type="plugin" value="stripe@claude-plugins-official" />
sync: { newMessages: 10, mock: true }
triaged: 10/10, drafts: 10/10, MOCK drafts in mailbox: 10, sent: 0
send task: WAITING_FOR_APPROVAL
approval shows: Send email to client1@customer.test: "Re: Question 1"
after approval: COMPLETED | MOCK sent: 1
audit counts: {
  'agent.create': 1,
  'approval.approve': 1,
  'approval.consume': 1,
  'approval.request': 1,
  'inbox.sync': 1,
  'integration.connect': 1,
  'mailbox.set_mode': 1,
  'org.create': 1,
  'task.create': 11,
  'task.transition': 78,
  'tool.inbox.categorize': 10,
  'tool.inbox.create_draft': 10,
  'tool.inbox.send_draft': 1
}
```

### M4–M8 — covered by automated tests (MOCK providers)

| Milestone | Acceptance check | Test |
|---|---|---|
| M4 | Inbox lead → contact + deal + note + draft follow-up, all tier 1; amount needs tier 3; stage tier 2; retried deal not duplicated | `packages/core/test/crm.test.ts` |
| M5 | Overdue detection; reminders each need approval; tier 3 create in exact cents; fractional/over-limit amounts rejected; Stripe request shape with idempotency keys | `packages/core/test/finance.test.ts` |
| M6 | Viewer can't approve; owner approves exact action and worker runs it; tier 4 confirm; audit filters, paging, CSV injection defused | `apps/web/e2e/approvals.spec.ts`, `packages/core/test/audit-log.test.ts` |
| M7 | Fact recalled across tasks; forgotten fact gone; agent notes stay in their task; injected "remember this" needs approval; memory can't grant permissions; no cross-tenant recall | `packages/core/test/memory.test.ts` |
| M8 | Cost recorded per call; budget stops the next call before it's made; month closes into ledger once; webhooks verified, stale/tampered rejected, replays ignored, paid invoice recorded once | `packages/core/test/billing.test.ts`, `apps/web/test/billing-router.test.ts` |

### Not verified (needs live accounts)

Gmail, HubSpot, Stripe Invoicing, platform Stripe Checkout, and Anthropic model calls. Steps in `live-integration-runbook.md`.

---

## Earlier record: Milestone 1 — 2026-11-03 (Session 2)

Environment: Claude cloud workspace, Node 22.23.4, pnpm 10.28.0, PostgreSQL 16.15 (local cluster).

### Verified command suite

```
### exit=0 :: pnpm install --frozen-lockfile
### exit=0 :: pnpm lint
### exit=0 :: pnpm typecheck
### exit=0 :: pnpm test
### exit=0 :: pnpm test:isolation
### exit=0 :: pnpm build
```

### Test summary

```
 Test Files  4 passed (4)
      Tests  30 passed (30)
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

### Tenant isolation report (`pnpm test:isolation`)

```
Tenant isolation report (querying as tenant A, app_user):
organizations          tenant A rows=1  tenant B rows visible=0
audit_events           tenant A rows=1  tenant B rows visible=0
organization_members   tenant A rows=1  tenant B rows visible=0
```

Negative control: with RLS disabled on `organization_members`, 5 isolation tests failed; re-enabling it restored 12/12. This shows the suite detects a broken policy.

### HTTP acceptance (`scripts/acceptance-m1.sh` against `next start`)

```
== Sign up three synthetic users
PASS  owner sign-up
PASS  staff sign-up
PASS  other-firm sign-up
== Create organizations
org A=<uuid>  org C=<uuid>
== Invite and list
PASS  owner adds staff as member
PASS  org A has 2 members
PASS  staff sees org A in their list
== Authorization
PASS  member cannot invite
PASS  anonymous request rejected
== Tenant isolation
PASS  org C owner cannot list org A
PASS  org C owner cannot invite into org A
PASS  org C owner sees only org C
== Pages
PASS  org page renders for owner
PASS  org page is 404 for other tenant
PASS  signed-out visitor redirected to sign-in
ALL ACCEPTANCE CHECKS PASSED
```

Server log for that run: 0 error-level lines; 1 "action denied", 3 "non-member access attempt", 1 "member added", 2 "organization created". No password values in the log.

Not covered here: visual check of the pages in a browser (no browser reachable from this workspace), email verification and password reset (deferred, see auth-adr.md).

## Session 5 — review fixes, 2026-11-04

Environment: Claude cloud workspace, Node 22, pnpm 10.28.0, PostgreSQL 16, system Chrome. Synthetic data, MOCK providers. **Not a production-readiness sign-off.**

```
### exit=0 :: pnpm install --frozen-lockfile
### exit=0 :: pnpm lint
### exit=0 :: pnpm typecheck
### exit=0 :: pnpm test
### exit=0 :: pnpm test:isolation
### exit=0 :: pnpm build
### exit=0 :: pnpm test:e2e
```

```
 Test Files  21 passed (21)
      Tests  263 passed (263)
 Test Files  1 passed (1)
      Tests  15 passed (15)
  8 passed (37.6s)
```

Browser tests (Chrome, production build + real worker):

- e2e/approvals.spec.ts:26:3 › approval center › a viewer sees what's waiting but can't approve
- e2e/approvals.spec.ts:38:3 › approval center › the owner can't approve their own request; the card says why
- e2e/approvals.spec.ts:46:3 › approval center › the owner sees who asked and the exact action, approves it, and the worker runs it
- e2e/approvals.spec.ts:63:3 › approval center › tier 4: one owner approves, a different owner confirms
- e2e/approvals.spec.ts:87:3 › approval center › the audit log shows the decisions and exports CSV
- e2e/approvals.spec.ts:101:3 › chat and the agent switch › starting a conversation opens it; a message gets a labelled MOCK reply from the lead bot
- e2e/approvals.spec.ts:114:3 › chat and the agent switch › an owner pauses all agents: banner everywhere and the lead bot hands nothing off; then resumes
- e2e/pages.spec.ts:14:1 › every org page renders

New core tests: `packages/core/test/review.test.ts` (17): honest outcomes, titles, MOCK prefix, approval context and headlines, cross-org id resolves to 'not found', per-viewer rules incl. two-owner tier 4, kill switch (incl. mid-plan stop with no repeated action), lead bot refusal while paused, chat author names, rate limit with audited denial, retry of escalated tasks.

Before/after screenshots: `evidence/session5/`.

## Scout Phase 0 baseline — 2026-11-04

Before any Scout changes, at commit 5ffbf78:

```
### exit=0 :: pnpm lint
### exit=0 :: pnpm typecheck
 Test Files  21 passed (21)
      Tests  263 passed (263)
### exit=0 :: pnpm test
 Test Files  1 passed (1)
      Tests  15 passed (15)
### exit=0 :: pnpm test:isolation
```

## Scout Phase 3 — plans, entitlements, quotas — 2026-11-04

Commands run (this session): `pnpm lint` exit 0; `pnpm typecheck` exit 0; `pnpm test` 23 files / 281 tests passed; `pnpm test:isolation` 15 passed (now seeds `usage_counters`); `pnpm build` compiled.

New `packages/core/test/entitlements.test.ts` (17 tests) proves:
- Catalog carries no prices; invalid `SCOUT_PLAN_CATALOG` fails loudly; legacy `free` = starter.
- `requireFeature` refuses Scout on Starter/Growth with `UPGRADE_REQUIRED`, audited as denied; allowed after upgrade.
- Task quota: the request past the limit is refused, the task row is not created, the counter stays exact, `quota.exceeded` audited.
- **Race:** 20 concurrent consumers against a limit of 7 → exactly 7 succeed, 13 get `QUOTA_EXCEEDED`, counter = 7.
- Seats enforced on invite (`UPGRADE_REQUIRED`, audited `seat_limit`).
- Signed Stripe webhooks: trialing/active → mapped plan; past_due keeps plan + warning flag; deleted/canceled/unpaid/incomplete_expired → starter; unknown or mis-mapped price → starter; an older event delivered late is ignored; a downgrade removes Scout immediately.
- `planSummary`: members can read; outsiders get NOT_FOUND. Exposed as `billing.plan` (covered by the auto-discovered all-endpoints isolation test) and on the Billing page.

Defect found and fixed while testing: denial audits opened a second main-pool connection while the caller held one; more than 10 simultaneous refusals deadlocked the 10-connection pool. Denial audits now use a separate 3-connection pool (`withTenantOutOfBand`) that never nests. The race test (13 simultaneous refusals) is the regression test.

Not yet covered here (later phases): Scout services/tools calling `requireFeature` at execution time (Phase 6), API-level and queued-task-after-downgrade adversarial tests (Phase 9).

## Scout Phases 4–5 — data model, roofing vertical, scoring — 2026-11-04

Commands: `pnpm lint` clean; `pnpm typecheck` clean; `pnpm test` 24 files / 306 tests passed; `pnpm test:isolation` 15 passed (all 9 new tables seeded and probed cross-tenant). Rollback 0011 applied and migration re-applied on the test database.

`packages/core/test/scout.test.ts` (25 tests) proves:
- CSV reader: quotes, doubled quotes, CRLF, BOM. Haversine: 1° latitude = 69.09 mi.
- SPC parser: combined three-section file and single sections; hail hundredths → inches; wind mph and `UNK`; tornado scale not treated as a magnitude; HHMM < 1200 → next UTC day incl. year rollover; digit-string coordinates (degrees west); unquoted commas in comments kept; bad rows reported with line numbers, not guessed; report day from `YYMMDD_rpts` file names; invalid dates refused; stable references so re-uploads dedupe.
- Score: every band of the ADR table; total = sum of factors; vertical text contains no damage claim and says a report is not evidence of damage.
- Access: Scout refused on Growth (`UPGRADE_REQUIRED`), writes refused to members (`FORBIDDEN`), outsiders get `NOT_FOUND`.
- Profile: scan refused until a person reviews it; any edit returns it to draft.
- Import: refused without attestation and a usage-rights description; only allow-listed columns stored (`ethnicity`, `income` in the file are dropped and reported); dedupe; rows count against the monthly allowance and an over-allowance file is refused whole.
- Scan: matches by distance (radius) and by county when no coordinates; out-of-area prospects ignored; all six explanation fields present; "Don't contact yet" without recorded permission; follow-up suggested only with permission; do-not-contact wins; re-scan updates instead of duplicating; a disqualified prospect isn't resurfaced; lookback window respected; new opportunities stop at the allowance.
- Retention purge deletes expired, unworked prospects, keeps worked ones, audits the count.
- Another org sees none of this org's Scout data.

Not live-verified: retrieving SPC files from the internet (network blocked here). The working path is a person uploading a CSV downloaded from SPC.

## Scout Phase 6 — orchestration, handoff, consent gate — 2026-11-04

Commands: `pnpm lint` clean; `pnpm typecheck` clean; `pnpm test` 25 files / 320 tests passed.

`packages/core/test/scout-flow.test.ts` (14 tests, real engine path with FakeMail/FakeCrm MOCK providers):
- Reviewing the profile creates the Scout agent; a scan is a task with a direct plan (no model), run by the task engine, audited as the Scout agent.
- Scan refused until the profile is reviewed.
- **Downgrade after queueing:** the queued scan fails at execution with the plan message, writes no opportunities, and the refusal is audited as the agent.
- Lifecycle: stages can't be skipped (qualify from prospect, hand off from engaged → CONFLICT); engagement needs evidence; qualification needs every checklist answer; disqualify needs a reason and is final; history records from/to/actor/evidence.
- Inbound email from a prospect → Engaged (system, with message reference) + inbound-inquiry permission; not for do-not-contact addresses.
- Handoff: three CRM writes each need approval (G7: the prospect's details are external data); nothing is written to the CRM before approval; stage becomes Opportunity only after the task completes; a rejected approval leaves it Qualified and allows a new request; duplicate in-flight handoff refused.
- Send gate: a prospect who wrote in can be emailed (send recorded against the opportunity); do-not-contact refused up front; **opt-out after approval is blocked at send time** with nothing sent and the block recorded; revoked permission blocked the same way; only managers record permissions, never for do-not-contact; opting out works on any plan and revokes permission; ordinary replies to non-prospects unaffected.

## Scout Phases 7–8 — dashboard, lifecycle UI, analytics — 2026-11-04

Commands: `pnpm lint` clean; `pnpm typecheck` clean; `pnpm test` 25 files / 360 tests; `pnpm test:isolation` 15; `pnpm build` compiled; `pnpm test:e2e` 10 passed (real production build + worker, system Chrome).

- API: `scout.*` router, 19 procedures (corrected: the commit message for fb359a4 says 21; `apps/web/test/scout-api.test.ts` asserts the count). The all-endpoints probe discovers each and proves another org's owner gets NOT_FOUND and a signed-out caller UNAUTHORIZED (127 probes). Services authorize before validating, so outsiders learn nothing from validation errors.
- Pages: Scout feed (stage counts, heuristic score with parts, closest report, DEMO labels, phone card layout), opportunity detail (six explanation fields, score table captioned "not a probability", evidence with source, UTC report times, history with names, contact status, engage / qualify / hand off / rule out), storm reports (filters, provenance, explicit "no map" note), setup (profile with review step, SPC upload, attested import, data sources), contact rules (do-not-contact, permissions), analytics (funnel + money, every number with its basis badge), Billing allowances, upgrade notice on plans without Scout.
- `e2e/scout.spec.ts`: DEMO labels; out-of-area prospect absent; no "warm lead" text; explanation fields; no damage wording; a person rules out an opportunity from the UI; engaged demo shows Qualify and the recorded permission; storm-report provenance and no-map note; setup shows reviewed + "(DEMO)" source; analytics shows all three basis labels and "Attribution unverified"; Starter org sees the upgrade notice; phone width (390 px) has no horizontal scroll and shows cards.
- Analytics test: funnel counted from records; estimates blank without customer figures; revenue counts only the handed-off person's paid invoice; cost per opportunity and pipeline value computed from customer-reported inputs and labelled Estimated; refused without Scout.
- Defect found and fixed: analytics counted handed-off opportunities only after someone opened the feed (lazy stage sync). Analytics now syncs first; covered by the test above.
- Screenshots: `docs/plans/evidence/scout/` (feed, feed-phone, opportunity, opportunity-engaged, signals, setup, contacts, analytics, upgrade).

## 2026-11-06 — Wave 1 trust + correctness (audit follow-up)

Environment: Node 22.21.1, pnpm 10.28.0, PostgreSQL 16 (roles wos_owner/app_user, FORCE RLS), Chromium.

- `pnpm lint` — clean (2 pre-existing errors fixed: unused import in `documents/forgery.ts`, useless assignment in `job-photos/service.ts`).
- `pnpm typecheck` — clean (packages/db, packages/core, apps/web).
- `pnpm test` — 42 files, 565 passed, 0 failed (includes 38 new: org membership/invitations, audit chain, engine cancel, inbox background sync, PII scrubbing).
- `pnpm test:isolation` — 15/15 (RLS proof re-run after migration 0018; new tables covered by auto-discovery).
- `npx next build --webpack` — success. (Default Turbopack build is OOM-killed on ≤4 GB machines; webpack is the documented fallback — README.)
- `pnpm test:e2e` — 20/20 in Chromium (invite flow, cancel button, chain badge, CSV export with chain columns, phone-width settings page).
- Migration 0018 applied to dev/test/e2e databases; rollback SQL shipped (`packages/db/rollback/0018_hardening.down.sql`; front-desk plaintext tokens are unrecoverable after rollback — rotate).
