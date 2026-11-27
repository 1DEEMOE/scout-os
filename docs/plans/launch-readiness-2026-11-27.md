# Launch readiness — 2026-11-27

Written by Claude acting as PM. Nothing here is independently verified; "locally verified" means run on my sandbox (Postgres 16), not CI and not production.

## Verdict: not ready to go live. Engineering is close; the remaining gates are owner and legal decisions.

## Done (engineering)
- PR #10: all five CI checks green on run #71 (Postgres 17 service).
- Data fixes 0020–0023: 0028/0029 written, 0020–0023 hardened, event bus now claims a lease before any provider call (two workers: effect runs once), breaker atomic, runner supports no-transaction migrations, write-denial tests for all eight new tables, retention script. Locally verified; PR for these opened as a draft so CI can run.
- Backups: `pnpm db:backup` exists and restore-verifies. A migration still must not run without a downloadable backup you have checked.

## Gates only the owner can clear (in order)
1. **Read the SQL**: 0013–0019 (applied, unreviewed), 0020–0023 edits, 0028, 0029 (`sql-for-review/`). `pnpm check:sql-review` proves the folder matches the real files.
2. **Render ownership**: `scout-os-db` lives in a different Render workspace from FLOW. Decide the home workspace before deploy.
3. **Backup, then staging deploy** per `docs/plans/staging-runbook.md`; set staging secrets yourself (Anthropic, Stripe, Google, SMTP). SMS stays in mock mode.
4. **Live verification**: nothing has run against live Stripe/Google/email. One pilot customer is the real test.
5. **Legal**: TCPA / CAN-SPAM / Google restricted scopes, trademark clearance on the product name, privacy policy and terms (counsel).
6. **Erasure**: account deletion is plan-only until the three findings in `docs/gap-status.md` are fixed; do not market "delete my data" until then.
7. **Pricing and positioning**: your call (CLAUDE.md: humans decide pricing and naming).
8. **External security audit**: not done.

## Not ready to market yet
No pilot, no live verification, no legal sign-off, no pricing. Marketing copy that claims results or compliance would be unsupported today.

## Next engineering steps (no owner gate)
CI on the draft PR; fix anything it finds; then the three erasure findings.

## Prepared for the owner (2026-11-27)
- SQL reading aid: `docs/plans/sql-review-guide.md`
- Render workspace options: `docs/plans/render-workspace-options.md`
- Staging runbook updated (gates, 25 migrations, retention): `docs/plans/staging-runbook.md`
- Pilot plan: `docs/plans/pilot-plan.md`
- Legal drafts for counsel (not publishable): `docs/commercial/legal/`
- Preliminary trademark look: `docs/commercial/legal/trademark-preliminary-search.md`. Finding: "Ascend Software" collides with existing Ascend Software, LLC marks (accounts-payable SaaS; business-automation software). "Scout" is internal only. Naming is the owner's call.
