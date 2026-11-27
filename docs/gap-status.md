# Readiness gaps: status after this change

Legend: BUILT = code + tests in mock mode only. BLOCKED = needs the owner, a person, or a live account. Nothing here has run against live services.

| # | Gap | Status | Where |
|---|---|---|---|
| 1 | Zero live verification | BLOCKED: needs live credentials and a pilot | owner |
| 2 | TCPA / Google restricted-scope / CAN-SPAM / trademark | BLOCKED: legal and Google process | owner + counsel |
| 3 | Email deliverability | WIRED: Postmark is the preferred sender, wrapped in the suppression-aware sender; bounce/complaint webhook at `/api/webhooks/mail/postmark` (shared-secret auth, 503-until-durable); durable store = proposed 0025 (in-memory fallback + loud warn meanwhile); DNS check = `scripts/check-mail-dns.mts`. NOT done: live Postmark test, SES/SNS signature verification | `core/src/mail/`, `apps/web/src/app/api/webhooks/mail/` |
| 4 | Deployment, error tracking, backups | Deploy stays BLOCKED (owner decision). Backups: BUILT — `pnpm db:backup` dumps with pg_dump, verifies by restoring into a scratch database, rotates old dumps; dedicated BYPASSRLS `wos_backup` role in `scripts/setup-local-db.sql` + `scripts/render-db-roles.sql`. Error tracking: BLOCKED | `scripts/backup.mjs` |
| 5 | Twilio managed numbers | WIRED: tRPC + front-desk settings UI, durable store (memory_records interim; proposed 0024 is the proper table), rotate re-points webhooks, owner-only Tier 3 provision/release. The A2P gate is now ENFORCED at the send boundary (see below). Never run against live Twilio | `core/src/speed/managed-service.ts` |
| 6 | Background inbox sync | CLOSED (was wrongly listed as open): self-perpetuating pg-boss chain, first beat enqueued on mailbox connect, stops on disconnect | `core/src/inbox/sync.ts` |
| 7 | Pilots | BLOCKED: needs a real customer | owner |
| 8 | Data export + account deletion | Export: WIRED (audited manager endpoint, JSON download). Erasure: plan-only by design — BLOCKED by the 3 findings below | `core/src/privacy/` |
| 9 | Invites for people without accounts | CLOSED (was wrongly listed as open): emailed 7-day token links, hash stored, accept flow serves non-users | `core/src/org/service.ts` |
| 10 | Migrations 0013-0018 unreviewed; 0020-0023 proposed | BLOCKED: owner SQL review | owner |
| 11 | Single-shot agent planning | CLOSED: `task.continue` lets an agent hand off a follow-up task with prior results (agent-written handoff note travels as external data); the follow-up re-runs the full classify→policy→approval pipeline; chains bounded (2 deep, 3 follow-ups per task, 8 tasks per chain) and attributed to the original requester | `core/src/tools/task.ts` |
| 12 | In-memory rate limiting, embedded worker | Rate limiting CLOSED (was wrongly listed as open): `rate_limits` table + `storage: "database"` since migration 0015. Embedded worker stays by design (monolith-first). | `apps/web/src/server/auth.ts` |
| 13 | External security audit | BLOCKED | owner |

## Findings from gap 8 that need an owner decision
1. `audit_events` (kept) references `approval_requests` with no ON DELETE action, so approval requests cannot be deleted while audit events are kept.
2. All tenant tables cascade from `organizations`. Deleting that row erases the retained tables (opt-outs, billing, audit). The plan therefore anonymizes the row instead.
3. The app DB role lacks DELETE on at least `organizations` and `audit_events`. Erasure needs a separate privileged path or a reviewed grant.
Retention of opt-outs, consent proof, billing and audit records is a drafting default marked `legalReview: pending`.

## Managed numbers (gap 5): what you must know before wiring it
1. **Carrier registration.** A new US local number can answer calls immediately, but texting from it is generally blocked or filtered until A2P 10DLC registration is approved (or a toll-free number is verified). Text-back therefore stays OFF (`channelReadiness`) until the owner records approval. Registration is done through Twilio's process, not by this code. Verify current carrier rules.
2. **Rotating the front-desk link breaks the number.** The webhook URLs contain the plaintext token, which exists only at enable/rotate time (only its hash is stored). `repointManagedNumber` must be called from enable and rotate, or voice and SMS stop working.
3. **Money.** Buying is Tier 3 with a named human approval; releasing is the same and irreversible (the number is lost). Who pays, and the price, are owner decisions. Live buying needs `WOS_MANAGED_NUMBERS=1` on top of credentials.
4. **One Twilio account.** Numbers are bought on the platform's account so the existing single-token webhook signature check still applies. Subaccounts would need per-tenant tokens.
5. **Crash safety.** An intent record is written before the purchase, and a retry looks the number up before buying, so a crash after buying does not buy twice. Tested with an injected failure; not tested against a real database or Twilio.

## SMS carrier-registration enforcement (V7 P0 #1)
**Before:** `channelReadiness` only drove a status display. Nothing checked registration where texts were actually sent, so a live number could text before carrier approval. A second bug: an owner-approved custom reply was sent with no from-number, i.e. from the platform default number instead of the number the customer contacted.

**Now:**
- One function, `smsRegistrationCheck`, decides whether a tenant may send a live text from a number. It FAILS CLOSED: missing, `not_started`, `pending`, `rejected`, malformed or unreadable records all block. A managed number's own record is authoritative; otherwise the owner's attestation (`attestSmsRegistration`, owner/admin only, audited at Tier 3) is used. The labelled mock port is exempt because nothing leaves.
- It runs in `gate()` (clean blocked outcome + audit) AND again inside `sendSmsGuarded`, the only function allowed to call the SMS port, immediately before sending. A test fails if any other source file calls the port.
- Each lead now stores the number the customer contacted (`smsFrom`); approved replies send from it.
- Tested against a LIVE-shaped (non-mock) port, with four deliberate sabotages confirmed caught: guard disabled, gate and guard disabled, approval path forgetting the number, and fail-open on unknown.

**What this does NOT do:** it cannot verify carrier state. It trusts a human-recorded status. Registration is done in Twilio's/carriers' process. Nothing here has run against live Twilio.

**Existing behavior found, not changed:** `fulfillSpeedApproval` does not carry over the "customer texted first" flag, so an approved reply to a customer who texted in is blocked as `no_consent` unless consent was separately recorded. Owner decision: should an approved reply to an inbound-initiated lead be allowed without a consent record?

**Operational impact:** every tenant that sends live SMS now needs a recorded registration for its sending number, including numbers the owner brought themselves and the platform default `TWILIO_FROM_NUMBER`. Until recorded, texts are blocked with a reason shown in the lead record.
