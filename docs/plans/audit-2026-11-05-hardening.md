# Scout OS — hardening pass, 2026-11-05 (branch `enhance/9-10`)

**SELF-ASSESSMENT.** Not an independent review. Base: `main` @ `77b391f` (main-next @ fbfe780). Method: fresh clone, full verified-command baseline, then a read of every unauthenticated surface, the deploy config, the email path and the front desk.

## Baseline as pushed

| Check | Result |
|---|---|
| `pnpm lint` | **FAIL**: 2 errors (unused imports in e2e demo scripts) |
| `pnpm typecheck` / `pnpm test` / `pnpm test:isolation` / build | pass: 586 tests, 15 isolation |
| Fresh-clone test defaults | **broken**: vitest defaulted to `scout_gaps_test`, migrations to `wos_test` |

## Findings and fixes (each fixed with tests, one commit each)

| # | Severity | Finding | Fix | Commit |
|---|---|---|---|---|
| 1 | High | **Booking rate limit never counted failed attempts.** Counts and the denial audit ran inside the booking transaction, so a bad slot, full slot or validation error rolled its own increment back. Proven: 30 failing attempts, never limited. | Counts commit in their own transaction before the attempt; first denial per window audited. | `cccbb3a` |
| 2 | High | **Rate limit keyed on a caller-supplied IP** (left-most `X-Forwarded-For`), so rotating fake IPs bypassed it. | `clientIp()` takes the N-th entry from the right (`WOS_TRUSTED_PROXY_HOPS`, default 1). | `cccbb3a` |
| 3 | Medium | Public booking endpoints returned raw internal error messages (with HTTP 400) to anonymous callers. | Typed errors only; everything else is a logged, generic 500. 16 KB body cap, 62-day range cap, field caps. | `cccbb3a` |
| 4 | Medium | `disclosureAck: Boolean(x)` accepted the string `"false"` as consent to the AI disclosure. | Must be literal `true`. | `cccbb3a` |
| 5 | **Critical (Law 5)** | **The web process used a superuser/BYPASSRLS connection for every public booking lookup.** On Render, whose default user isn't a superuser, every booking link would also 404. | Migration 0019: one read-only RLS policy; `app_user` reads only the channel whose token hash it presents. The web service has no admin credential. | `26aec0d` |
| 6 | High (Law 5) | `render.yaml` connected both services as Render's default database user (the owner, able to disable RLS). | `DATABASE_URL` = `app_user` (set by hand), role script `scripts/render-db-roles.sql`, runbook §6. | `26aec0d` |
| 7 | High (Law 7) | Rollbacks for 0017/0018 left their `schema_migrations` rows, so re-migrating silently skipped them. | Rows deleted; `scripts/test-rollbacks.sh` round trip now passes (was failing). | `26aec0d` |
| 8 | High (product) | **No platform email was ever delivered** (password reset, invitations, verification: MOCK console only). | SMTP sender (`SMTP_URL` + `MAIL_FROM`, any provider; nodemailer 10.2.1, MIT-0). **Live delivery UNVERIFIED.** | `d3eeaae` |
| 9 | High (Law 2) | The invite form said **"Invitation emailed"** when nothing was sent (MOCK sender reported success). Forgot-password promised a link that never came. | `emailDelivery: sent / failed / not_configured`; both screens say plainly when email isn't set up. Mail logs drop recipient addresses. | `d3eeaae` |
| 10 | High (product, audit C1) | **Front desk unreachable**: an API with no screens. | Settings → Front desk (link shown once, pause/resume, replace link at tier-4 audit, repeating slots, requests waiting) and public `/book/<link>` page (phone-first). Slot validation added. | `da7907c` |
| 11 | Medium | The channel list sent the token hash to every member's browser (a read key under 0019). | Removed from the response. | `da7907c` |
| 12 | Low | Lint red; fresh-clone test DB mismatch; three rate-limit tests could flake across a minute boundary. | Fixed. | `4ad941f`, `cccbb3a` |

Corrected during this pass: an early note said `/api/healthz` was missing; it exists (`app/api/healthz/route.ts`) and is fine.

## Verified after (this machine, 2026-11-05)

`pnpm lint` 0 · `pnpm typecheck` 0 · `pnpm test` **613 passed / 44 files** · `pnpm test:isolation` **15** · `next build --webpack` 0 · `pnpm test:e2e` **21 passed** (new: `front-desk.spec.ts`) · `scripts/test-rollbacks.sh` PASS (0001–0019). Screenshots: `docs/plans/evidence/front-desk/`.

## Scores (honest, with what moves them)

| Area | Before (11-06 audit) | Now | What it takes to reach 9+ |
|---|---|---|---|
| Architecture & data model | 8.5 | 8.5 | Unchanged |
| Safety system (tiers, approvals) | 8 | 8.5 | Independent review of the engine; real-model red-team of the lead bot |
| Security operations | 5 | 7.5 | External pen test; per-IP limits on sign-in in shared storage (multi-instance); secrets rotation runbook; reconciler with a dedicated BYPASSRLS role |
| Product completeness | 4 | 5.5 | Speed-to-lead autopilot (M1), chat across domains (M2), live Gmail/HubSpot/Stripe |
| Market readiness | 3 | 3.5 | Pricing (owner), public trust page (M3), real customers |
| Engineering discipline | 7 | 8 | CI actually running on GitHub; keep lint green |
| **Overall** | **6** | **~7** | See below |

**9–10 is not reachable by code alone.** It also needs: the owner's SQL review of 0013–0019; live verification of SMTP, Gmail, HubSpot, Stripe and the AI model; a compliance review (CAN-SPAM, TCPA, state privacy, list licences); a "Scout OS" trademark search; an independent audit; and pilot customers. Release status remains **NO-GO** until those are done.

## Next engineering waves (recommended order)

1. CI on GitHub (`.github/workflows/ci.yml` exists but has never run against this repo) so every push proves lint/test/e2e.
2. M1 speed-to-lead autopilot: instant acknowledgment of new leads (within approval rules: auto-acknowledge templates as an owner-approved tier-2 policy), missed-lead alerts.
3. M2 chat across domains: read-only cross-domain questions first (tier 0), actions through the existing approvals.
4. Independent audit (fresh reviewer) of this branch before merge.
