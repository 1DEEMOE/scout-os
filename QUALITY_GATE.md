# Quality gate — merged branch (v6 series + production-hardening)

Run 2026-11-23 on this tree against a real PostgreSQL 16 (local, 127.0.0.1:5432).
Only checks that were executed are listed. Nothing here ran against a live provider.

| Check | Command | Result |
|---|---|---|
| Typecheck (3 packages) | `pnpm -r typecheck` | PASS, 0 errors |
| Lint | `npx eslint .` | PASS, 0 errors |
| Core tests | `npx vitest run packages/core` (two batches) | PASS, 579/579 (56 files) |
| DB tests (incl. backup script, proposed 0021–0027 isolation, pack-id drift) | `npx vitest run packages/db` | PASS, 32/32 (10 files) |
| Web tests (incl. endpoint isolation) | `npx vitest run apps` | PASS, 488/488 (20 files) |
| Tenant isolation | `pnpm test:isolation` | PASS, 25/25 (7 files) |
| Guardrail evals | `pnpm --filter @wos/core evals` | PASS, 17/17 |
| Rollback round-trip (migrations 0001–0019) | `node scripts/test-rollbacks.mjs` | PASS, schema identical |
| Durable event bus, scratch DB with proposed 0020–0023 applied | `node scripts/test-durable-events.mjs` | PASS, 34/34 |
| Production build | `WOS_MOCK_MODE=1 pnpm build` | PASS |

Total unit/integration tests: 1099 (579 + 32 + 488), plus 34 in durable mode.

## Not run
- Browser e2e (Playwright): not run on this merged tree.
- Anything against live Gmail, Stripe, Twilio, Postmark, Anthropic or NOAA.
- Deploy, staging, backup restore on real infrastructure.
- CI workflow itself (`.github/workflows/ci.yml`) has not run on GitHub.

## Test notes
- Tests share one database and must run one file at a time; do not run suites in parallel against `wos_test`.
- `query-shape` now disables seq scans for its one query so the result no longer depends on how many rows earlier tests left in `tasks`.
- Pending SQL (0020–0027) is never applied to the default test DB. Only `test-durable-events.mjs` applies 0020–0023, to a scratch database it creates and drops.
