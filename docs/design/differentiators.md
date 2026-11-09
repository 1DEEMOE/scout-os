# ADR-007: Five differentiators (branch `feat/differentiators`)

Status: built and tested on `feat/differentiators`, not merged. Clean-room: no competitor code, text, assets or UI was copied. All wording and icons are our own.

| # | What | Where | Real or MOCK |
|---|---|---|---|
| 1 | **Opportunity finder.** Public storm and permit signals go through one adapter interface (`finder/adapters.ts`). Roofs re-done 15+ years ago near fresh storm reports become prospects, scored by Scout's existing rules. Addresses with a roof permit in the last 60 days are skipped, because another contractor has them. **First outreach** is drafted from the evidence and goes out only after an **owner** approves it. | `finder/service.ts`, `tools/outreach.ts`, Scout → "Find jobs near me", opportunity → "First message" | Adapters are **MOCK** (deterministic, invented, `example.test` emails, labelled DEMO/MOCK). A live NOAA SPC or county permit feed plugs in behind the same interface after a licence and terms review. Sending is real through a connected mailbox. |
| 2 | **Visible approval levels 0–4** in plain words ("Level 2 · Talks to customers") on approval cards, approvals legend, routines, invoices, front desk, Help. **Owner-only holds:** bank-detail changes, invoices held as possibly forged (now level 3), Scout's first outreach. Admins see these read-only with the reason. **Never auto-pay.** | `engine/owner-only.ts`, `decideApproval`, `approvalsForReview`, `ui.tsx` (`TierBadge`, `LevelsLegend`, `OwnerOnlyBadge`), Invoices → "Check an incoming invoice" | Real enforcement in platform code, not prompts. |
| 3 | **Tamper-resistant claim packet:** photos and written notes in one SHA-256 hash chain (each links to the previous), timestamped and attributed, verified on every view, exported as a **PDF** with every hash and a packet fingerprint. | `job-photos/service.ts` (`addJobNote`), `job-photos/packet-pdf.ts`, job page → "Claim packet" | Real. It documents integrity checks and doesn't prove what a photo shows (the PDF says so). Claim and carrier numbers wait on proposed 0024. |
| 4 | **Setup in under 10 minutes from one invite link**, with a timed e2e test. | ADR-006, `e2e/plug-and-play.spec.ts` | Real. Last run: about 9 s, 6 client clicks. |
| 5 | **AI visibility check** ("do assistants recommend you?") with score, trend and 3 fixes, plus a **booking endpoint other AI assistants can discover** (`/api/front-desk/<code>/openapi.json`, advertised from the booking page). Assistants must identify themselves, and every request still waits in approvals. | `ai-visibility` page, `api/front-desk/[token]/openapi.json`, Front desk → "For AI assistants" | Visibility provider is **MOCK** until a live provider is reviewed (the page says so). The booking endpoint is real. |

## Rules kept

- Routines still run at levels 0–1 only. Anything from email or chat still needs approval. Level 4 still needs a second confirmation from a different owner.
- The new owner-only rule only tightens. It's enforced in `decideApproval` before any other check and audited as `owner_only` denials.
- First outreach uses the front desk's proven pattern: one pre-planned step plus its approval row, bound by an action digest. **No agent was given new permissions.** At send time the tool re-checks the do-not-contact list and recorded permission, so a stale approval can't get around them.
- No migration was applied. Proposed 0020 and 0024 are in `packages/db/proposed/` for Darian's SQL review, dry-run applied and rolled back on a throwaway database.
- **Booking origin check (decision for review):** main added a same-origin check to `POST /bookings` that also rejected requests with *no* Origin header, which blocked every server-to-server caller, i.e. exactly the AI assistants #5 is for. The endpoint is anonymous and cookie-free, so there's no session for a cross-site request to ride on. Now: a request **with** a foreign Origin (another site's page in a visitor's browser) is still blocked (403, e2e-tested); a request **without** Origin is allowed and goes through rate limits, validation, the AI-identification rule and the approval queue.
- Demo data never claims a real source: DEMO storm evidence now reads "invented sample storm report (DEMO), not real weather data".

## Tests

- Unit and integration: `finder.test.ts` (7), `owner-only.test.ts` (3), `claim-packet.test.ts` (4), updated `payment-guard.test.ts` (admins now refused on bank-detail changes).
- The all-endpoints isolation sweep covers every new procedure.
- e2e: `differentiators.spec.ts` (5 browser flows with axe), plus `plug-and-play.spec.ts` for #4.
