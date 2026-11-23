# Ascend Software — status (2026-11-17)

> **2026-11-23 update (Kimi review round, merged onto the v6 series):** proposed
> migrations 0020–0023 were reviewed (`docs/plans/migration-review-0020-0023.md`)
> but are **NOT adopted**: they stay in `packages/db/proposed/` until the owner
> approves them. The durable event journal, dead letters and shared circuit
> breaker are built and tested but **opt-in** (`WOS_DURABLE_EVENTS=1`, needs 0022
> applied); the default path uses the audit-trail journal and in-process breaker.
> CI added (`.github/workflows/ci.yml`), security review
> (`docs/security/audit-2026-11-23.md`), staging runbook
> (`docs/plans/staging-runbook.md`) and `scripts/verify-live-integrations.mjs`.
> Evidence: `QUALITY_GATE.md`. Still not deployed; live integrations and the
> independent human audit remain open.

Repo at `/workspace/scout-os/repo`. Phase 9 self-assessment completed locally. Nothing deployed. No push. Clean-room rules intact.

## SMB launch-readiness gaps (2026-11-17 session)
All seven gap-review items built and verified locally, one commit each (e94300b…2809ebb on top of main @ 439561d):

| Gap | State |
|---|---|
| Booking API open to outside AI agents | Done — server-to-server callers (no Origin) accepted; browsers cross-site still blocked |
| Customer-facing rebrand | Done — Ascend Software everywhere customer-facing |
| Automatic NOAA SPC storm feed | Done — worker syncs current day + 2-day lookback per eligible tenant via the integration bus; manual CSV still works |
| Pricing page + self-serve signup | Done — `/pricing` + `/pricing/start`, all prices from planCatalog/PRICING_DISPLAY_JSON, no numbers in code |
| Live AI-visibility provider | Done — opt-in `AI_ANSWERS_PROVIDER=anthropic-websearch`, deterministic scoring, mock stays default |
| Missed-call answering | Done — Twilio voice/SMS webhooks, signature-verified, consent ledger, one pre-approved text-back, voicemail task |
| One-command setup | Done — `pnpm setup` (env secrets, roles/DBs, migrations, verification), idempotent |

## Vertical jobs workspace (2026-11-18 session)
The elite-pack engine is now a product surface: **Jobs** (pack-driven intake form → deterministic estimate → approval-gated send → booked → dispatched → in progress → done) and a **Dispatch** day board with crew lanes. Elite packs now cover **moving, house cleaning, HVAC, and plumbing**; the setup wizard badges industries that include the workspace. Estimates stay blocked until the owner confirms real prices and the pack's required business fields (e.g. USDOT) are on file; the send itself waits on a human approval at the pack's compliance floor. Interim persistence in `memory_records`; proposed migration **0026** (jobs + jobs_config, forced RLS, no DELETE) is ready for review with a rollback-transaction isolation test.

Verification: lint 0, typecheck 0, full suite **1017** unit/integration tests (incl. self-verifying backup runs against real pg_dump/pg_restore and the jobs pipeline end-to-end against real Postgres), **23** isolation (RLS + proposed-migration rollback suites, every tRPC procedure probed cross-org and signed-out), webpack build clean, bootstrap run live against real Postgres 16 (idempotent + failure-path checked), **e2e 51/51** (Chrome, production build + real worker). Evidence: `QUALITY_GATE.md`; details: `docs/plans/session-log.md` sessions 8–9.

## CRM parity sprint (2026-11-18 session)
Feature audit of Salesforce, HubSpot, Pipedrive, Freshsales, monday and Zoho turned into clean-room equivalents of the standard CRM core:

- **Native deal pipeline** — the Sales page is now a real board: lead → qualified → quote sent → negotiation → won/lost, per-org win-probability weights (basis points, manager-tunable), and a weighted forecast computed on read from the same rows the board renders, so the two can never disagree. Deals are never deleted; reopening a closed deal is manager-only; won↔lost directly is refused.
- **Contact 360** — every contact page shows a transparent lead score (fixed rules, each with its points and reason), append-only notes, and a merged timeline of deals, synced CRM rows, invoices, emails, and jobs — assembled on read, never stored, so it can't drift from the systems of record.
- **Public lead-capture form** — `/f/<token>` shares the front-desk booking link's token (one public capability to guard; pausing the desk closes the form). Off by default; a manager turns it on in Front desk settings. Honeypot, per-IP rate limits (counted in their own committed transaction so failed attempts still count), daily abuse cap, 24h deal dedupe. Submissions need no approval: nothing leaves the workspace (tier-0 audit, no PII in metadata).
- **Proposed migration 0027** (deals, pipeline_configs, append-only contact_notes, lead_forms, `web_form` contact source) with rollback file, README row, and a transaction-rollback isolation test. **Not applied** — Darian reviews; interim persistence in `memory_records` per convention.

Verification: lint 0, typecheck 0, full suite **1060** unit/integration tests, **25** isolation, webpack build clean (all new routes listed), **e2e 53/53**, quality gate PASS (3/3). Evidence: `QUALITY_GATE.md`; details: `docs/plans/session-log.md` session 10.

**Still open (owner):** TCPA review of the text-back template · live-credential testing (Twilio/Anthropic/Stripe) · trademark clearance · independent audit · push/deploy authorization.



## Done (Phases 0–9 self-assessment)
| Phase | What |
|---|---|
| 0–1 | Discovery audit + architecture ADR-004 |
| 2 | Customer-facing rebrand to Ascend Software (`apps/web/src/brand.ts`); security headers |
| 3 | Plans/entitlements/quotas; Stripe webhook plan updates |
| 4–5 | Scout data model; roofing + NOAA SPC CSV; prospect import; heuristic score |
| 6 | Scout agent + lifecycle + consent/suppression at send |
| 7–8 | Scout API + dashboard UI + DEMO seed |
| 9 (this run) | 5k import batching; billing race fixes (newest sub, webhook claim, AI budget reserve); adversarial extras (kill switch on scout scan, forged plan, suppression-over-permission); user-facing README/CLAUDE/readiness rebrand; e2e re-run |

## R1 — routines engine + Morning Briefing (2026-11-05, SELF-ASSESSMENT)
- Migration 0013_routines (+ rollback), core/routines, routine worker, Routines + Briefing UI; tier 0–1 only, tier 2+ → Approvals unchanged.
- lint 0, typecheck 0, **443** unit tests, **15** isolation, build 0, **e2e 11/11** (port 3300).
- Report: `/workspace/scout-os/r1/REPORT.md`. SQL awaiting Darian's review. Not merged/deployed.

## Latest verified results (box, 2026-11-05 America/New_York)
- Baseline (HEAD fe638f3): lint 0, typecheck 0, **392** unit tests, **15** isolation, build 0
- After Phase 9 fixes: lint 0, typecheck 0, **401** unit tests, **15** isolation, build 0, **e2e 10/10** (Chrome; ran on port 3300 locally to avoid existing demos on 3100/3200)
- Evidence screenshots: `docs/plans/evidence/scout/` and `/workspace/scout-os/phase9/shots/`
- Full write-up: `/workspace/scout-os/phase9/FINAL-REPORT.md` (**SELF-ASSESSMENT**, not independent)

## Bugs fixed this run
1. **5,000-row prospect import** exceeded Postgres bind-param limit → batched inserts (~1000) in `importProspects` + test.
2. **Stripe current subscription** returned oldest row → order by `updatedAt` desc.
3. **Webhook duplicate/out-of-order race** → claim `webhook_events` row before apply; DELETE on failure so retries can re-claim; out-of-order ignored.
4. **Parallel AI calls overshooting monthly budget** → migration `0012_ai_budget_reserve.sql` + atomic reserve/settle via `usage_counters` metric `ai_cost_micros`.

## Approval rules (unchanged — do not loosen)
- Tier 2+ needs a human; tier 4 needs a second confirmation from a **different** owner (no single-owner exception — owner decision still open).
- Email/chat-origin forces tier ≥ 2; lead bot capped at tier 3; sole-manager self-approve is audited.

## Not done / release decision: **NO-GO**
- Independent audit not completed (this report is self-assessment only).
- Live integrations unverified (Gmail, HubSpot, Stripe checkout/webhooks, Anthropic, live SPC fetch).
- Trademark clearance for "Ascend Software" not done.
- Compliance review (CAN-SPAM / TCPA / state privacy / list licenses) not done.
- Staging, monitoring, Phases 10–12 blocked pending owner authorization.
- Open owner decisions: pricing, plan contents, member tier-3 tasks, single-owner tier-4 exception, launch channels (email vs email+SMS).

## Internal vs customer-facing names
Customer-facing: **Ascend Software**. Internal packages `@wos/*`, env `WOS_*`, DB roles `wos_*` kept on purpose.
