# Round 2

Status: pack data and the signed-in screens. Schema change is proposed only (`packages/db/proposed/0023_pilot_metrics.sql`) and is not applied. `0021` stays proposed; its industry check list includes the new pack ids so a later review can store them on `organizations.industry`. Until then the pack id stays in `memory_records` (`speed:pack`).

## Why

A signed-in page should fail in a way the owner can leave, not as a blank crash. Packs should be one record per trade so adding a business is data, not a new code path. Setup stays the three welcome steps, budgeted under 10 minutes. Prices in a pack are examples. Reply templates stay unsent until a person approves them. Routines stay tier 0 or 1. SMS stays mock. Nothing is paid automatically.

## Packs

`packages/core/src/industries/schema.ts` is the one shape: job stages, starter services, approval-gated reply templates, tier 0–1 routines, morning-brief metrics, and suggested calendar, CRM, and accounting connections. `catalog.ts` adds the broader trades: home and field, auto, beauty, health and wellness with no health records, pets, food, retail, professional services, education and childcare, events, and a pre-seed startup pack (SaaS, agency, DTC). Search filters that list. Other / custom calls `closestPack` and starts from that pack. The owner can change services later.

Health, childcare, and pet packs do not store diagnoses, prescriptions, or medical records.

## Pilot numbers

Stored in `memory_records` (`pilot:metrics`), audited, and shown on Today:

- Setup time: from the first industry choice to finish.
- First reply: when setup finishes with the pack templates approved. That approval is the human OK. It does not send.
- Bookings recovered: a missed or late-cancelled visit that is booked again. Starts at zero.
- Hours saved: 6 minutes times each morning briefing that actually ran, labelled as an estimate.

## Handoffs

Settings shows calendar, CRM, and accounting as not connected, connected, failing, or recovered. Failing means an open dead letter for that lane. Recovery is the existing replay page. Suggested integrations on a pack are not connections.

## Page errors

`error.tsx` on the root and under an organization, plus `global-error.tsx`, explain the failure and offer Try again and a way back. They do not send, pay, or approve.
