# Readiness gaps: status after this change

Legend: BUILT = code + tests in mock mode only. BLOCKED = needs the owner, a person, or a live account. Nothing here has run against live services.

| # | Gap | Status | Where |
|---|---|---|---|
| 1 | Zero live verification | BLOCKED: needs live credentials and a pilot | owner |
| 2 | TCPA / Google restricted-scope / CAN-SPAM / trademark | BLOCKED: legal and Google process | owner + counsel |
| 3 | Email deliverability | BUILT (adapter, bounce/complaint handling, suppression-aware sender, SPF/DKIM/DMARC checker). NOT wired: webhook route, durable suppression table, DNS fetch, live Postmark/SES test | `core/src/mail/` |
| 4 | Deployment, error tracking, backups | BLOCKED: no deploy by rule; Sentry/DR are owner decisions | owner |
| 5 | Twilio managed numbers | not started | |
| 6 | Background inbox sync | not started | |
| 7 | Pilots | BLOCKED: needs a real customer | owner |
| 8 | Data export + account deletion | BUILT as export + erasure PLAN (never executes). Erasure is BLOCKED by 3 findings below | `core/src/privacy/` |
| 9 | Invites for people without accounts | not started | |
| 10 | Migrations 0013-0018 unreviewed; 0020-0023 proposed | BLOCKED: owner SQL review | owner |
| 11 | Single-shot agent planning | not started | |
| 12 | In-memory rate limiting, embedded worker | not started | |
| 13 | External security audit | BLOCKED | owner |

## Findings from gap 8 that need an owner decision
1. `audit_events` (kept) references `approval_requests` with no ON DELETE action, so approval requests cannot be deleted while audit events are kept.
2. All tenant tables cascade from `organizations`. Deleting that row erases the retained tables (opt-outs, billing, audit). The plan therefore anonymizes the row instead.
3. The app DB role lacks DELETE on at least `organizations` and `audit_events`. Erasure needs a separate privileged path or a reviewed grant.
Retention of opt-outs, consent proof, billing and audit records is a drafting default marked `legalReview: pending`.
