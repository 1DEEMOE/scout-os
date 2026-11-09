# Round 2

Status: pack data and the signed-in screens. Schema change is proposed only (`packages/db/proposed/0023_pilot_metrics.sql`) and is not applied. `0021` stays proposed; its industry check list includes the new pack ids so a later review can store them on `organizations.industry`. Until then the pack id stays in `memory_records` (`speed:pack`).

## Why

A signed-in page should fail in a way the owner can leave, not as a blank crash. Packs should be one record per trade so adding a business is data, not a new code path. Setup stays the three welcome steps, budgeted under 10 minutes. Prices in a pack are examples. Reply templates stay unsent until a person approves them. Routines stay tier 0 or 1. SMS stays mock. Nothing is paid automatically.

## Packs

Five shared bases supply the shape, and each trade is an overlay: urgent-trade (plumbing, HVAC, electrical, roofing), recurring-service (cleaning, landscaping, pest), auto (repair, plus tire, glass, and detailing), booking-beauty (salon, barbershop waitlist, nail and lash, med spa), and quote-velocity (movers, junk removal with a photo step). Dental is a thin booking overlay: a recall list uses only a name and a last appointment date. Each base has job stages, five starter services, three reply templates that stay unsent until a person approves them, three tier 0–1 routines, a morning metric, and suggested calendar, CRM, and accounting connections. Nail, lash, and med spa deposit wording is a request you approve. Nothing is charged automatically. The next wave is photography, pressure washing, veterinary front desk, tax prep, and real estate. Lighter packs cover restaurants and food, retail, towing, startups, and counseling, plus Other / custom.

Health, childcare, pet, dental, veterinary, counseling, and med spa packs do not store diagnoses, prescriptions, charts, or session notes.

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
