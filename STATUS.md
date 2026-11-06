# Scout OS — status (2026-11-05)

Repo at `/workspace/scout-os/repo`. Phase 9 self-assessment completed locally. Nothing deployed. No push. Clean-room rules intact.

## Done (Phases 0–9 self-assessment)
| Phase | What |
|---|---|
| 0–1 | Discovery audit + architecture ADR-004 |
| 2 | Customer-facing rebrand to Scout OS (`apps/web/src/brand.ts`); security headers |
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
- Trademark clearance for "Scout OS" not done.
- Compliance review (CAN-SPAM / TCPA / state privacy / list licenses) not done.
- Staging, monitoring, Phases 10–12 blocked pending owner authorization.
- Open owner decisions: pricing, plan contents, member tier-3 tasks, single-owner tier-4 exception, launch channels (email vs email+SMS).

## Internal vs customer-facing names
Customer-facing: **Scout OS**. Internal packages `@wos/*`, env `WOS_*`, DB roles `wos_*` kept on purpose.
