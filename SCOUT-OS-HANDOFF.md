# Scout OS — Handoff Brief
"Your AI workforce. Finding opportunities. Running operations." General AI operating system for small/mid-size businesses; first vertical: roofing.

## Stack
pnpm 10.28.0 monorepo: apps/web (Next.js), worker (pg-boss), @wos/db (Postgres, forced RLS), @wos/core. Set WOS_MOCK_MODE=1 to mock AI.
Run: `COREPACK_HOME` if needed, then `corepack enable && pnpm install && pnpm test` (see repo README).

## State (branch main-next @ fbfe780)
Tests: 586 unit, 15/15 tenant isolation, 20/20 e2e (incl. 390px phone). Self-assessed, not independently audited.
Built: approvals tiers 0–4, routines engine + morning briefing, 6-step setup wizard, simplified 5-group nav + mobile bottom bar, routine-run recovery scanner, bank/payment-change guard (call-back to on-file number), AI front desk (agent-bookable, approval-gated), AI-answers visibility check (mock provider), tamper-evident job photos + claim packet, forged invoice/estimate detection, team invite/role/remove, expiring approvals, tamper-evident audit log.

Peachtree walkthrough fixes in this commit:
- Front-desk booking approvals store the executor `actionDigest` (no DIGEST_MISMATCH on approve; digest verification kept).
- Public bookings show "Front desk: <name>" and the AI assistant's name when present (not "Former member").
- Invoice risk flags use plain language.
- The Overdue card lists only overdue invoices; paid/upcoming are separate.
- Claim-packet hashes wrap on a phone (no horizontal overflow at 390px).
- Morning briefing shows homeowner names and plain source labels.

A local SAMPLE walkthrough (Peachtree Roofing) is written by `apps/web/e2e/peachtree-seed.ts` and `peachtree-walkthrough.ts`. Screenshots default to `apps/web/test-results/evidence/` (`WOS_EVIDENCE_DIR` or `DEMO_DIR` to put them somewhere else).

## Non-negotiable rules
- Never loosen approval tiers; routines run only tier 0–1; anything from email/chat needs approval; tier-4 needs a different owner.
- Never auto-pay. No PII in logs. Clean-room only (no copying competitors).
- Migrations 0013–0018 are unreviewed — do not apply to any real database before owner review.
- No push, deploy, or paid services without explicit authorization.

## Open work
Pricing, QuickBooks, live NOAA storm feed, SMS/voice (pending TCPA legal review), live AI-answers provider, front-desk settings screen, cloud photo storage, live Stripe/Gmail/HubSpot testing, independent audit, trademark search, compliance review.
