# Elite industry packs: schema ADR (slice 1)

Status: proposed. Scope of this slice: schema, estimate engine, disclosure injection, and one reference pack (moving).

## Decision
Add an **additive** `elite/` layer next to the v1 pack. `packSchema` (v1) is unchanged, so all 60 overlays keep working.
An elite pack attaches to an overlay by `id` (`ELITE_PACKS[id]`). A trade with no elite pack stays a "credible" v1 pack.

## What an elite pack declares
intake (typed, conditional, required, plus the spoken question for the AI front desk) · pricing (variant + common line rules, deposit, tax) ·
scheduling · documents · compliance (forbidden fields, required business fields, approval floors, disclosures) · cadences · KPIs · integrations · FAQ · briefing sections.

## Safety properties enforced by the schema, not by convention
- Prices are `priceBasis: "example"` and `bindingAllowedByDefault: false` (literals).
- `dispatchRequiresApproval` is the literal `true`.
- Every cadence has `approvalTier >= 2` and `consentCheckedAtSend: true`; SMS bodies must carry STOP; only allow-listed placeholders.
- Approval floors cannot be set below tier 2.
- Pricing rules and conditions may only reference declared intake fields.
- Disclosures carry `legalReview: "pending"` as a literal. Code cannot mark legal text approved.

## Estimate engine (`buildEstimate`)
Pure function, integer cents. Output is always `draft_needs_approval`. Binding requires the owner switch **and** owner-confirmed prices; otherwise it is downgraded to non-binding with a warning.
Binding => tier 3, non-binding => tier 2. Example prices and missing business-profile values (USDOT/MC for interstate) populate `blockedReasons`, so nothing is sendable on sample data.

## Not in this slice
Persistence of owner price overrides (needs a table, so SQL for review in `packages/db/proposed/` with rollback and RLS tests), UI wiring into onboarding and the front desk, and the e2e path.
