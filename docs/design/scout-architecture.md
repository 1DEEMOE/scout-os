# ADR-004: Scout OS — Lead Intelligence, Entitlements and Rebrand (Phase 1 plan)

Status: PROPOSED and being implemented in Session 6. Owner approval is required for anything marked **DECISION**.
Inputs: Scout OS Master Engineering Directive v1.0; Phase 0 discovery (`docs/research/scout-phase0-discovery.md`).

## 1. Principles carried over

Everything Scout does goes through the existing engine: tasks, policy tiers, approvals bound to action digests, audit, queue, kill switch, budget cap. Scout adds data and deterministic code; it does not add a second execution path. Scoring and matching are plain code, not model output, so every number can be explained.

## 2. Rebrand (Phase 2)

- Customer-facing name **Scout OS**, tagline "Your AI workforce. Finding opportunities. Running operations." from one `brand.ts` module.
- Internal identifiers (`@wos/*` packages, `WOS_*` env vars, `wos_*` roles and databases, `wos_idempotency_key` HubSpot property, `<wos-…>` Message-IDs) are **kept**. Renaming them would break running installs, stored data and provider-side references. Documented as compatibility identifiers.
- Agent display names follow the directive roster. Kinds are unchanged except the new `scout`:

| Directive role | Kind | Display name |
|---|---|---|
| SCOUT | `scout` (new) | Scout |
| INBOX | `inbox` | Inbox |
| PIPELINE | `sales` | Pipeline |
| FOLLOW-UP | (inbox drafts + consent gate) | Follow-up (logical; no separate agent) |
| BILLING | `finance` | Billing |
| ANALYST | analytics service | Analyst (logical; no agent tools yet) |
| COORDINATOR | lead bot + orchestrator | Coordinator |

- Security headers added with the rebrand (finding E-2): `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`.
- N/A in this repo (documented, not silently skipped): marketing site, email templates, PWA manifest, support materials. None exist yet.

## 3. Plans, entitlements, quotas (Phase 3)

- **Plan catalog** in code with defaults, overridable by `SCOUT_PLAN_CATALOG` (JSON, validated). **No prices in code** (DECISION: pricing). Plans are hypotheses: `starter`, `growth`, `scout_pro`, `enterprise`.
- **Resolution**: `organizations.plan` holds the current plan, written only by the Stripe webhook (price → plan via `STRIPE_PRICE_PLAN_MAP`) or a platform-operator function (not exposed through the API). Status mapping: `active`, `trialing` → mapped plan; `past_due` → mapped plan plus a visible warning (grace); anything else (`canceled`, `unpaid`, `incomplete_expired`, deleted) → `starter`. Legacy value `free` reads as `starter`, so no data rewrite (Law 7).
- **Features** checked server-side in every Scout service and every Scout tool at execution time, so a downgrade also stops queued work. The UI hides nothing that the server doesn't also refuse.
- **Quotas** in `usage_counters (tenant_id, metric, period, used)`, consumed by one statement: `INSERT … ON CONFLICT DO UPDATE SET used = used + n WHERE used + n <= limit RETURNING used`. No row returned means over quota. Atomic under concurrency, with no read-then-write race. Metrics: `tasks` per month, `scout.opportunities` per month, `scout.prospect_rows` per month. Seats are checked when inviting.
- To limit regression risk, the existing features (agents, chat, CRM, finance) stay in every plan; plans differ in limits plus Scout. Moving features between plans is a DECISION.

## 4. Scout data model (Phase 4) — migration 0011, additive (quotas are 0010)

All tables are tenant tables: forced RLS, composite FKs, minimal grants, isolation-test seeds.

| Table | Purpose | Key rules |
|---|---|---|
| `usage_counters` | Quotas | Unique (tenant, metric, period) |
| `business_profiles` | One per org: website, industry (vertical id), service area, services, ideal customer, pricing notes, lead criteria, budget | `status` draft → reviewed. Scout won't scan until a person marks it reviewed. Suggestions are stored with `source: "suggested"` and are inert until confirmed. |
| `intelligence_sources` | Where data came from | `kind`: `noaa_spc_storm_reports`, `crm_contacts`, `customer_import`. License and usage-rights text; imports need an attestation (who, when, what rights). |
| `signal_observations` | Observable events (hail, wind, tornado reports) | Source, event time, collection time, place, coordinates, magnitude, confidence basis, limitations, unique `external_ref` per source (dedupe) |
| `prospects` | Person or organization possibly relevant | Provenance (source + row), unique `dedupe_key`, optional link to an existing contact, `retention_until`. Only allow-listed columns are imported; nothing that infers protected characteristics. |
| `opportunities` | A prospect + supporting signals + heuristic score + lifecycle stage | One open opportunity per prospect and vertical. `stage`: `prospect`, `engaged`, `qualified`, `opportunity`, `disqualified`. Explanation and score breakdown stored with the row. |
| `communication_permissions` | Basis for contacting someone, per channel | `existing_customer`, `inbound_inquiry`, `express_written_consent`; evidence; revocable |
| `suppression_list` | Do-not-contact | Unique (tenant, channel, value). Checked before any send. |
| `opportunity_events` | Append-only stage history | From/to stage, actor, evidence text (added in implementation: the funnel and lifecycle need history, not just the current stage) |
| `outreach_events` | Record of follow-up sends and blocks | Attributed, linked to the opportunity |

`agents.kind` check gains `scout`. Retention: prospects default to `retention_until = created + 365 days` (configurable); a purge function deletes expired prospects that aren't linked to a CRM deal and audits the count (E-7).

## 5. Lifecycle (directive §5)

| Stage | Entered when | Who |
|---|---|---|
| Signal | An observation is stored | Import / adapter |
| Prospect | Scout matches a prospect to signals in the reviewed service area | Scout task |
| Engaged | Evidence of interaction: an inbound email from the prospect's address (detected) or a person records the interaction with a note | System or person (attributed) |
| Qualified | Engaged **and** the vertical's qualification checklist is answered by a person | Person |
| Opportunity | Qualified **and** handed off to Pipeline, with a CRM deal created through approvals | Person + Pipeline agent |
| Disqualified | Any time, with a reason | Person |

Stages can't be skipped (enforced in code and tested). The UI says "Prospect · not contacted", never "warm lead".

## 6. Roofing vertical (Phase 5)

- **Vertical framework**: `verticals/<id>.ts` exports signal kinds, demand triggers, qualification checklist, score weights and limitations text. Only `roofing` is registered. Auto glass, HVAC, solar and commercial are listed as `planned` with no code paths.
- **Signals**: NOAA SPC local storm reports. Facts verified on SPC's pages: UTC times, report day 12:00–11:59 UTC, hail in hundredths of an inch, wind in mph or `UNK`, sections for tornado/hail/wind. The parser accepts the combined file (three headed sections) or single sections, coordinates as decimals or as SPC's digit strings, and assigns HHMM < 1200 to the next calendar day. **Live fetch: UNVERIFIED** (network blocked here); a person can upload a CSV downloaded from SPC, which is a real, working path. Every signal stores source, collected-at, place, confidence ("preliminary local storm report; not quality-controlled"), limitations and usage rights ("US government work, public domain").
- **No damage claims.** Explanations say "a hail report of 1.75 in. was made 2.1 miles away"; never "roof damaged". No imagery, no AI inspection.
- **Matching**: prospect inside the reviewed service area, a storm report within `radiusMiles` (default 10) and `lookbackDays` (default 30) by haversine distance; without coordinates, same county and state (lower geographic score).

### Heuristic score (labelled "Heuristic score, not a probability")

| Factor | Max | Rule |
|---|---|---|
| Signal relevance | 30 | Hail ≥1.75 in. 30 · ≥1 in. 20 · smaller 8; wind ≥75 mph 20 · ≥58 mph 12 · unknown 6; tornado 30 |
| Freshness | 20 | ≤7 days 20 · ≤30 14 · ≤90 8 · older 2 |
| Geographic fit | 20 | ≤3 mi 20 · ≤10 mi 14 · county match only 8 |
| Data reliability | 15 | Existing CRM contact 15 · attested import with coordinates 10 · attested import, county only 5 |
| Verified engagement | 15 | Engaged or existing customer 15 · none 0 |

Each opportunity stores the six answers: why identified, why relevant, evidence (signal ids with source), missing information, recommended action, confidence basis. A calibrated probability is not shown: no historical outcomes exist (directive §8).

## 7. Orchestration (Phase 6)

1. **Scout scan** = a task for the `scout` agent with a direct plan `scout.scan` (tier 1: internal writes). It runs in the worker, so it gets audit, retries, idempotency, the kill switch and the entitlement check at execution time.
2. **Hand off to Pipeline** (qualified only) = a task for the `sales` agent: `crm.upsert_contact`, `crm.create_deal`, `crm.add_note`. The prospect record travels as external data, so G7 forces approval for the CRM writes. Agents don't inherit Scout's permissions: Pipeline uses its own grant. *Implementation change:* there is no `scout.mark_handed_off` tool (it would have needed a new permission on every existing Pipeline agent). Instead `syncHandoffs` moves the opportunity to `opportunity` only when the handoff task reaches COMPLETED, and clears the link if it FAILED (including a rejected approval). Evidence names the task id.
3. **Follow-up** = an inbox draft on the prospect's own email thread. `inbox.send_draft` refuses do-not-contact recipients, and Scout prospects without an active recorded permission for email, **at send time** (after approval), and records the block in `outreach_events`; `requestSendDraft` checks early too so nobody approves something that can't go out. An inbound email from a prospect moves them to Engaged and records an `inbound_inquiry` permission (unless suppressed). Adding to do-not-contact revokes any permission and works on every plan.
4. **No cold outreach tool exists, by design** (directive §10: public contact info is not permission). SMS, calls and AI calling are not built.
5. Dead letters: tasks that exhaust retries become ESCALATED, visible on Overview, with Retry for managers (Session 5). Approval expiry, cancellation (reject), event correlation (task id, chain id, opportunity id in audit metadata) all reuse the engine.

## 8. Dashboard and analytics (Phases 7–8)

- **Scout**: opportunity feed (stage, heuristic score with breakdown, explanation panel, provenance and confidence on every signal), signal table filtered by kind/state/date (no decorative map), business profile and review, prospect import with attestation, usage against quota.
- **Analytics**: funnel counts (signals → prospects → matched → contactable → engaged → qualified → opportunities → deals won), costs, revenue. Every number is labelled **Observed** (from records), **Customer-reported** (typed in: monthly data cost, average job value), or **Estimated** (computed from customer-reported inputs; the directive's term, replacing "Derived"). Revenue counts paid invoices for people handed to Pipeline: observed, with attribution labelled unverified. Estimates are blank, not guessed, when their inputs are missing.
- Upgrade notice for orgs without Scout. The server refuses the same calls.

## 9. Compliance gates (DECISION / legal review)

Consent and suppression enforcement here is a technical control, not legal advice. Before any customer uses Scout with real prospects, a qualified reviewer must confirm: CAN-SPAM handling (sender identity, opt-out link) for email; TCPA/state rules before any SMS or calling is built; privacy notices for imported personal data (state privacy laws); and the data licenses of any imported list. Release gate: **compliance review completed**, currently not done.

## 10. Acceptance criteria per phase

| Phase | Criteria (all automated unless noted) |
|---|---|
| 2 | Brand text from one module; headers present on every page (test); no internal identifier renamed; e2e green |
| 3 | Scout API and tools refuse orgs without the feature (API test, direct core call, queued task after downgrade); quota cannot be exceeded under 20 concurrent consumers; cancel/past_due/trial transitions via signed webhooks; seats enforced |
| 4 | New tables forced-RLS, seeded in isolation test, cross-tenant probes fail; rollback SQL present |
| 5 | Parser handles SPC formats incl. UNK and 12Z day rollover; dedupe; matching distances correct; score breakdown sums; explanation fields always present; no damage language |
| 6 | Scan runs via worker; handoff needs approval; stage can't skip; suppressed or unconsented send blocked and recorded |
| 7–8 | Pages render (e2e), demo data labelled DEMO, funnel labels present |
| 9 | Adversarial suite passes; independent audit has no open critical finding |
| 10–12 | NO-GO until hosting, real accounts, compliance review and owner approval |
