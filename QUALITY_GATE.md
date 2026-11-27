# Quality gate — merged branch with 0020–0023 adopted

Run 2026-11-23 on this tree against a real PostgreSQL 16 (local, 127.0.0.1:5432), test DB migrated from `migrations/` (23 files).
Only checks that were executed are listed. Nothing here ran against a live provider, and no real database has had these migrations applied.

| Check | Command | Result |
|---|---|---|
| Typecheck (3 packages) | `pnpm -r typecheck` | PASS, 0 errors |
| Lint | `npx eslint .` | PASS, 0 errors |
| Core tests | `npx vitest run packages/core` (two batches) | PASS, 579/579 (56 files) |
| DB tests (backup script, pack-id drift, query shape) | `npx vitest run packages/db` | PASS, 28/28 (7 files) |
| Web tests (incl. endpoint isolation) | `npx vitest run apps` | PASS, 488/488 (20 files) |
| Tenant isolation (adopted tables seeded; proposed 0024/0026/0027) | `pnpm test:isolation` | PASS, 21/21 (4 files) |
| Event bus in audit-trail fallback (`WOS_DURABLE_EVENTS=0`) | `npx vitest run` on the 4 event tests | PASS, 43/43 |
| Guardrail evals | `pnpm --filter @wos/core evals` | PASS, 17/17 |
| Rollback round-trip (0009–0023, incl. the four adopted rollbacks) | `node scripts/test-rollbacks.mjs` | PASS, schema identical |
| Production build | `WOS_MOCK_MODE=1 pnpm build` | PASS |

Total unit/integration tests: 1095 (579 + 28 + 488).

## Not run
- Browser e2e (Playwright) on this tree.
- The GitHub Actions workflow itself.
- Anything against live Gmail, Stripe, Twilio, Postmark, Anthropic or NOAA.
- Applying migrations to staging or production, deploy, backup restore on real infrastructure.

## Test notes
- Tests share one database and must run one file at a time; do not run suites in parallel against `wos_test`.
- `query-shape` disables seq scans for its one query so the result does not depend on how many rows earlier tests left in `tasks`.
