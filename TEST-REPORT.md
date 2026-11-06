# Scout OS r1 — Verification Report (SELF-ASSESSMENT, not an independent review)
Date: 2026-11-05 (America/New_York). Base: 40ad7c1 → HEAD f7aab64. Mock mode (WOS_MOCK_MODE=1), local Postgres, DBs scout_verify / scout_verify_test / scout_verify_e2e, port 3400 (3100/3200 untouched).

## Results
| Check | Result | Evidence |
|---|---|---|
| Install | PASS | logs/install.log |
| Migrations up from zero (13) | PASS | logs/migrate-up1.log, migrate-up2.log |
| Rollbacks down + up, schema identical | FAIL→fixed→PASS | logs/rollback.log, schema-diff.txt, rollback-roundtrip.log, rollback-roundtrip2.log |
| Lint | PASS | logs/lint.log, lint2.log |
| Typecheck | PASS | logs/typecheck.log, typecheck2.log |
| Unit/integration x3 (+1 after fixes) | PASS 443/443 x3, 444/444 final; no flakes | logs/test-run1..4.log |
| Isolation tests | PASS 15/15 | logs/isolation.log, isolation2.log |
| Build | PASS | logs/build4.log |
| E2E (original 11 + verify spec) | PASS 17/17 | logs/e2e5.log |
| All nav pages owner/member/viewer, no console errors / unexpected 4xx-5xx | PASS (after viewer fix) | e2e5.log, shots/ |
| Sign-up, sign-in, sign-out | PASS (sign-out added) | verify.spec |
| Password reset | NOT IMPLEMENTED / NOT TESTED | no route exists |
| Invite | PASS | verify.spec |
| Lead-bot chat (mock) | PASS | existing e2e |
| Create task | PASS | verify.spec |
| Approvals tier 2 approve/reject | PASS | e2e |
| Approvals tier 3 | PASS (unit/integration only; not driven via UI) | test logs |
| Approvals tier 4 second owner | PASS | existing e2e |
| Pause-all banner + blocking | PASS | existing e2e |
| Scout import incl. 5,000 rows / quota | PASS (5,000 refused correctly with 4,993 left; 4,993 imported; ssn column ignored) | verify.spec |
| Consent-blocked outreach | PASS (unit/integration scout-adversarial, scout-flow); UI only checks do-not-contact add | test logs |
| Billing page | PASS (mock) | verify.spec |
| Routines create/pause/resume/run-now, Morning Briefing | PASS | e2e |
| Audit log (+CSV) | PASS | e2e |
| /healthz | NOT PRESENT (no endpoint; not added) | — |
| Worker | PASS indirectly (jobs processed: approved task completed, routine run written) | e2e logs |

## Bugs found and fixed (local commits only, nothing pushed)
1. ce2eff9 — 0012 rollback left its schema_migrations row (re-up skipped 0012, lost webhook_events DELETE grant). Now transactional + deletes row; added scripts/test-rollbacks.sh.
2. b4870a4 — e2e seeds hardcoded wos_e2e (would reset shared DB); now honour E2E_OWNER_DATABASE_URL.
3. e157911 — No sign-out anywhere in UI; added button.
4. 1da88e9 — Quota message said "used up" when rows remained; now "has N left; this needs M." + test.
5. f7aab64 — Viewers got HTTP 500 on /scout/* (core permission error). Now 404 + Scout/Analytics nav hidden. Approval/permission rules NOT loosened.

## NOT TESTED (needs live services)
Live Stripe, Gmail, HubSpot, real AI model, live NOAA feed; password reset (not implemented); real email delivery of invites.

## Remaining issues
- No password-reset flow. No /healthz endpoint.
- Tier-3 approval and consent-blocked sending not exercised through the UI.
- 7 demo rows count against the 5,000/month Scout quota.
