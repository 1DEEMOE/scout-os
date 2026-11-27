# Pilot plan (one real customer, staging-grade, no paid services)

Written by Claude for the owner to run. Nothing here has been executed.

## Goal
Prove, with one real small business, that the product does the three things the marketing would claim, using real provider accounts in test mode where a provider has one.

## Pick the pilot
One business you know personally (e.g. an AscendTaxes client or an auto glass / roofing contact). Written permission to use their anonymised results. Their data goes only into the staging system after the privacy draft is in place.

## Setup (target: under 30 minutes, timed by the app's pilot metrics)
1. Create the workspace, choose the industry pack, connect Gmail (read/send scopes only after the Google restricted-scope question is settled; until then use the SMTP-only path).
2. Stripe in **test mode** only. SMS stays **mock**.
3. Turn on the daily briefing routine.

## What to test, and what counts as a pass
| # | Scenario | Pass |
|---|---|---|
| 1 | A new lead email arrives; assistant drafts a reply; owner approves; reply sent | draft within 5 min, nothing sent without approval |
| 2 | Tier-2+ action (e.g. invoice) | blocked until approved; tier 4 needs a second owner |
| 3 | Briefing arrives | all sections present; approvals always shown |
| 4 | Provider outage simulated (bad key) | breaker opens, dead letter recorded, replay works after fixing |
| 5 | Same event delivered twice | one effect (check Stripe test dashboard / sent mail) |
| 6 | Data export | JSON downloads, contains only that tenant |
| 7 | A second test workspace | cannot see the first workspace's data |
Record: setup time, time to first approved reply, bookings recovered, every error. Keep a daily 5-minute note for 7 days.

## Stop conditions (stop the pilot and tell me)
Any message sent without approval, any cross-tenant data visible, any charge outside test mode, any customer complaint about unwanted contact.

## After
Fill `docs/plans/pilot-results.md` (to be created by the owner or me): what worked, what failed, quotes with permission. Only then decide pricing and marketing claims.
