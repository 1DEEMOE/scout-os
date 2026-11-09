# Scout OS: readiness scorecard, 2026-11-08 (branch `feat/differentiators`, merged with `main` @ 439561d)

**SELF-ASSESSMENT, not an independent review.** The previous scorecard is `audit-2026-11-05-hardening.md` (overall about 7). Release status stays **NO-GO** until the items in "What only Darian can do" are done.

## Verified on this machine

| Check | Result |
|---|---|
| `pnpm lint` / `pnpm typecheck` | 0 errors |
| `pnpm test` | **850 passed** (66 files) |
| `pnpm test:isolation` | **20 passed** (applied schema, plus proposed 0021–0024 each applied in a transaction and rolled back) |
| `next build --webpack` | OK |
| `pnpm test:e2e` | **56 passed** (axe WCAG 2.2 AA on every new screen) |
| Invite → first briefing (timed e2e) | **7 s total, 6 client clicks** (limits: under 10 min, at most 15) |
| GitHub Actions CI | Runs on every push. It caught 3 real test failures on this branch before this pass; they're fixed. |

## Found and fixed in this pass

| Severity | Finding | Fix |
|---|---|---|
| **High (availability)** | Behind a proxy chain, better-auth couldn't resolve the client IP and put **every** sign-in into one shared rate-limit bucket, so one attacker could lock all users out. | Auth now uses the same trusted-hop client IP as the booking API. A spoofed internal header is stripped. A test fails without the fix and passes with it. |
| High (product vs. security) | `main`'s same-origin check on public bookings rejected requests with no Origin, which blocked every AI assistant (the point of differentiator #5). | Foreign-origin browser posts are still blocked. Server-to-server calls are allowed and go through rate limits, validation, AI identification and approvals. Both cases are e2e-tested. |
| Medium | `kimi.routine` parsed the routine text before checking workspace access, so an outsider could probe it. | Access is checked first. Caught by the all-endpoints sweep. |
| Medium (honesty, Law 2) | DEMO storm evidence said "Source: NOAA SPC local storm report". | It now reads "invented sample storm report (DEMO), not real weather data". An e2e test asserts no NOAA source appears on DEMO data. |
| Low | My proposed migration number collided with `main`'s 0021. | Renumbered to 0024, with its own rolled-back isolation test. |

## Scores

| Area | 11-05 | Now | What moves it to 9+ |
|---|---|---|---|
| Architecture & data model | 8.5 | 8 | **Down on purpose:** five proposed migrations (0020–0024) are unapplied, so several features keep state in `memory_records`. Reviewing and applying them is the biggest structural gain. |
| Safety system (tiers, approvals) | 8.5 | **9** | Owner-only holds, levels shown everywhere, consent re-checked at send time, no agent permission widening. Needs an independent review of the engine. |
| Security operations | 7.5 | **8** | External pen test; a secrets rotation runbook; a reconciler role with only BYPASSRLS. |
| Product completeness | 5.5 | **7.5** | Finder, owner-approved outreach, claim packet PDF, AI visibility, AI booking, plug-and-play setup, plus `main`'s industry packs and speed-to-lead. Held back by **live integrations being unverified** (Gmail, SMTP, Stripe) and **MOCK** feeds (storms, permits, AI visibility). |
| UX & accessibility | – | **8.5** | Calm chat-first UI, command palette, phone parity, axe-clean flows. Needs real-user sessions. |
| Engineering discipline | 8 | **8.5** | CI on every push, small commits, ADRs. Keep `main` green and require CI before merge (branch protection: a repo setting Darian controls). |
| Market readiness | 3.5 | 4 | Pricing, trademark, compliance review, pilots. See below. |
| **Overall product/engineering** | **~7** | **~8** | |
| **Overall business readiness** | | **~5** | Can't pass 6 without the items below. |

## What only Darian can do (each one is a real step toward 9–10)

1. **SQL review of applied migrations 0013–0019 and proposed 0020–0024.** Applying the proposals removes the `memory_records` workarounds.
2. **One real connection of each:** a Gmail mailbox, an SMTP sender, Stripe in test mode. Then I run the live checks and change the docs from UNVERIFIED to verified.
3. **A staging deploy on Render.** It's a paid resource, so it needs your OK.
4. **Pricing numbers** (CLAUDE.md: the owner decides).
5. **A "Scout OS" trademark search** and a compliance review (CAN-SPAM, TCPA, state privacy) before any outreach goes to real people.
6. **One to three pilot roofers** through the invite link. `main`'s pilot metrics record setup time and first-reply time.

## Next engineering steps I can take without you

- A live NOAA SPC storm adapter behind the existing interface (the data is US-government work, public domain). Needs a network allowance or a scheduled fetch outside this sandbox.
- A shared rate-limit store for the public booking API (sign-in already uses the database).
- A pass to merge `main`'s inbox/recovery screens with the new levels so every page uses the same `TierBadge`.
