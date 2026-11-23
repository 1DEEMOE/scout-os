# Proposed migrations

Files here are **proposals for Darian's SQL review**. 0020–0023 were reviewed and adopted on 2026-11-23 (now in `../migrations/`); 0024–0027 below are still unreviewed. The migration runner
(`src/migrate.ts`) only reads `../migrations/`, so nothing in this folder is
ever applied automatically. To adopt one after review: move it into
`../migrations/`, move its rollback into `../rollback/`, add the Drizzle
columns in `src/schema.ts`, and run `scripts/test-rollbacks.sh`.

| File | Why | Code that waits on it |
|---|---|---|
| `0024_managed_numbers.sql` | One managed phone number per workspace: phone, provider SID, status, A2P registration state. Partial unique indexes enforce one active number per workspace and one holder per phone. Same RLS and grants as 0001–0019; no DELETE (released records are kept) | Not applied. The app stores the record in `memory_records` (`speed:managed-number`). `packages/db/test/proposed-0024-isolation.test.ts` applies this file inside a transaction and rolls it back. |
| `0025_platform_mail_suppressions.sql` | Platform-wide bounce/complaint suppression for the SaaS's own transactional mail (not tenant outreach). Global tables like `rate_limits` — a bounce is a property of the address, not a tenant | Not applied. Until it is, suppression is process-local (logged warning) and the bounce webhook answers 503 so providers retry |
| `0026_jobs.sql` | Vertical jobs workspace: job rows (intake answers, crew, schedule, status pipeline, sent-estimate snapshot) and per-org pricing/business config. Statuses and ids are CHECK-constrained; no DELETE (a job is a financial record) | Not applied. The app stores jobs in `memory_records` (`job:<id>`, scope `jobs`) and recomputes estimates on read. `packages/db/test/proposed-0026-isolation.test.ts` applies this file inside a transaction and rolls it back. |
| `0027_crm_pipeline.sql` | Native CRM pipeline: deals (CHECK-constrained stages/sources, no DELETE — won/lost are statuses), per-org stage weights, append-only contact notes (no UPDATE/DELETE), one lead form per front-desk channel, and `web_form` added to the contacts.source CHECK. Same RLS and grants as 0001–0019 | Not applied. The app stores deals in `memory_records` (`deal:<id>`), notes at `note:<contactId>:<noteId>`, and configs as single org rows (`pipeline-config`, `leadform:config`); form-sourced contacts carry source `inbox` until the CHECK widening lands. `packages/db/test/proposed-0027-isolation.test.ts` applies this file inside a transaction and rolls it back. |
