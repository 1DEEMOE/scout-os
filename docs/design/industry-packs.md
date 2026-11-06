# Industry packs

Status: built on `feat/speed-to-lead`. Schema change is proposed only (`packages/db/proposed/0021_industry_packs_and_speed.sql`) and is not applied.

## Why

Selling should be near-turnkey. The operator picks a trade when creating the invite. The client confirms the business name, hours or service area, connects one channel (or skips), and approves the replies in one tap. That tap is the human approval. About 90% of the workspace is already the pack: service menu with example prices, pipeline names, intake fields, a morning list, and routines that only list or draft (tier 0–1).

Packs are versioned data (`PACK_VERSION` in `packages/core/src/industries/packs.ts`) checked by `packages/core/src/industries/schema.ts` and `packages/core/test/industry-packs.test.ts`. They are not code forks.

## What a pack contains

- Flow: `job` (quote and visit) or `appointment` (service menu with duration, staff or chair time). Beauty packs are appointment-first and are not medical.
- Example prices, always flagged `priceIsExample`. Nothing is charged.
- Reply templates staged `ready_to_approve`. Approving them is tier 2 and audited. A send that is not that wording still goes to Approvals.
- Routines at tier 0 or 1 only (briefing, re-service or rebook lists, review lists, no-show lists). Sending is not part of the routine.
- Pipeline stage names and intake fields for that trade.
- Morning lines for that trade.
- Signal sources: weather (NOAA, free, only roofing, HVAC, auto glass, tree service), seasonal calendar, past-customer interval, and mock new-mover or permit feeds. Scores are points with a reason. They do not claim damage.

`organizations.industry` can still only be `roofing` or `general` until 0021 is reviewed. The pack id lives in `memory_records` (`speed:pack`).

## Speed, texts, and trust

Texts use a Twilio-shaped port that is MOCK only. No paid account and no live send. Consent, STOP, and 8am–9pm recipient local time are checked at send time. Today shows the respond-in-60s count. `/trust` explains the rules in plain language and does not invent customers or statistics.
