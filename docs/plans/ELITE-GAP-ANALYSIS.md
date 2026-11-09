# Elite gap analysis — Scout OS

**Status: SELF-ASSESSMENT.** This file is the author's inspection of the tree it names. It is not an independent verification. A separate reviewer re-runs the gates.

**Inspected:** `main` at `ff59f125a6d03511b377de59ee5f905b41df2d7f` (merge of PR #4, `feat/pack-hardening`), checked out as `feat/elite-engineering` before any implementation commit on that branch.

**Written:** 2026-11-06 (America/New_York). The attached brief `SCOUT-ELITE-ENGINEERING-PROMPT` was written against an older remote (`main` `77b391f`, `ui/chat-first` `4b28c7d`). Those seed IDs are re-checked below and closed when the current tree already contains the fix.

**Standard used:** the 20-section brief, plus the repo laws in `CLAUDE.md` (approval floors, proposed SQL only, no production claim).

## 1. Scope and method

Read, not assumed:

- Engine: `packages/core/src/engine/{orchestrator,policy,executor,tools,queue,tasks,router}.ts`
- Money and provenance: `finance/payment-guard.ts`, `documents/forgery.ts`, `billing/metering.ts`
- Untrusted text: `SAFETY_PREAMBLE`, `externalData`, `taintedArgs`; tests in `engine.test.ts`, `inbox.test.ts`, `chat.test.ts`
- Outbound I/O: `speed/nws.ts` (`api.weather.gov` only), Stripe webhook `apps/web/src/app/api/webhooks/stripe/route.ts`, Gmail/HubSpot/Stripe SDKs
- HTTP surface: `apps/web/src/app/api/**/route.ts` (no `middleware.ts`)
- Auth rate limit: `apps/web/src/server/auth.ts`, migration `0015`
- Logs and traces: `logger.ts`, `otel.ts`, `tracing.ts`
- Isolation and schema: migrations `0001`–`0019` applied by the migrator; `packages/db/proposed/0020` and `0021` not applied
- Queues: pg-boss in `engine/queue.ts`; routine recovery in `routines/reconcile.ts`
- Nav and health: `nav-model.ts`, `api/healthz/route.ts`
- Acceptance stance: `docs/plans/acceptance.md` (development evidence, not a production sign-off)

Commands run for this inspection (no product code changed yet):

- `git rev-parse HEAD` → `ff59f125a6d03511b377de59ee5f905b41df2d7f`
- `rg` across `packages/core/src` and `apps/web/src` for circuit breakers, dead letters, CSRF, SSRF, fetch call sites, tool output schemas, correlation ids

Not run for the inspection itself: lint, the full unit suite, isolation, build, e2e, a load generator, or `EXPLAIN`. Those run after implementation and are recorded in the second pass. No production database, no paid provider, no deploy.

## 2. What is already in place (do not rebuild)

| Area | Evidence | Consequence |
|---|---|---|
| Approval floors | `evaluatePolicy` in `engine/policy.ts`: tier 0–1 allow, 2–3 one human, 4 two confirmations. No skip setting. | New code must call this, not a second policy. |
| Email/chat provenance | `taintedArgs` forces tier ≥ 2 when an address or URL in tool args also appears in external text. `ROUTINE_MAX_AUTONOMOUS_TIER = 1`. | Event handlers that send mail or SMS are out of the bus. |
| No auto-pay | `payment-guard.ts` floors payment-detail tools at tier 3. Forgery raises approvals. | No pay tool on the bus. |
| Idempotent side effects | Tool `idempotencyKey`, `workflow_executions`, unique `audit_events (tenant_id, idempotency_key)`, usage-event idempotency, routine run keys. | The bus should use the audit unique key, not a new applied table. |
| Retries | `orchestrator.ts` `RETRY_SCHEDULED` with `2 ** (attempts-1) * base`, then `ESCALATED`. `retryEscalatedTask` for managers. | Task retry UI exists on the task page. Integration poison messages do not. |
| Model ledger | `assertWithinBudget` reserves `usage_counters`; `recordModelUsage` writes `usage_events` with tokens and micro-dollars. | Routing is the gap, not the ledger. |
| Tenant isolation | `FORCE ROW LEVEL SECURITY` on tenant tables; `pnpm test:isolation` covers the applied schema. `workspaceSnapshot` runs inside the caller transaction. | A cross-tenant prompt test is still missing (see E1.3). |
| Prompt wrapping | `externalData` strips a closing tag. Inbox and chat tests cover injection text. | SMS and weather text are not covered by those tests. Unknown tool names fail the task (`INVALID_ACTION`) but a dedicated hallucination test is thin. |
| Stripe webhooks | `constructEvent` + `WebhookSignatureError` → 400. Test in `billing-router.test.ts`. | Only webhook in the tree. |
| Health | `GET /api/healthz` runs `SELECT 1`, 503 when the database is down. | Does not report integration breakers. |
| Structured logs | pino, `REDACT_PATHS`, `scrubPii` on email-shaped strings and named PII fields. | No correlation id, no input hash, phone numbers in free strings are not masked. |
| Spacious chat-first UI | Five primary items + More. Axe work landed before this SHA. | Do not compact the shell. |

### Seed findings from the brief that are closed on this SHA

| Brief id | Claim against the old remote | On `ff59f125` |
|---|---|---|
| E0.2 | Light-mode axe contrast on More headings | Fixed on `ui/chat-first` and merged. Not reopened by this inspection. |
| E0.1 (SQL half) | Migrations 0013–0019 waiting in an open PR | Those files are in `packages/db/migrations/` on this main. They are applied by the local migrator. 0020 and 0021 stay proposed. |
| E1.1 | Plug-and-play onboarding absent | `welcome.tsx`, `/admin/clients`, `plug-and-play.spec.ts` (≤10 client clicks). |
| E1.2 | No palette, rail, or profile menu | `nav.tsx`, command palette, icon rail. |
| E1.4 | Speed-to-lead and cross-domain chat absent | `speed/service.ts`, `chat/read.ts` `read.workspace`. Sends still go through templates or approvals. SMS is mock. |

Still true from the brief, and carried forward: production readiness is **NO-GO** (`docs/plans/acceptance.md`, `docs/plans/readiness-report.md`). Live SMTP, Gmail, HubSpot, Stripe, and a real model have not been exercised here. OTel is a no-op without `OTEL_EXPORTER_OTLP_ENDPOINT`. This document does not flip that gate.

## 3. Critical deficiencies (P0)

No new data-loss or auth-bypass defect was found in this pass. One standing P0 remains, and it is a release gate rather than a patch:

| ID | Finding | Evidence | What “fixed” means |
|---|---|---|---|
| P0-1 | Production is still NO-GO. Claiming otherwise would be a false readiness statement. | `docs/plans/acceptance.md` header; `docs/plans/readiness-report.md`; brief §0.8 | Keep the NO-GO label. Do not deploy. Do not describe this branch as independently verified. |

Approval, payment, and isolation regressions would become P0 the moment a change weakens them. The implementation pass adds tests that those floors still hold. It does not add a bypass.

## 4. Major deficiencies (P1)

Score is `Impact × Frequency × Risk reduction × Automation value × User value ÷ Complexity`, each factor 1–5. Higher is earlier.

| ID | Score | Finding | Evidence |
|---|---|---|---|
| P1-1 | 5×4×5×4×4÷3 ≈ 533 | No integration event pipeline. pg-boss runs tasks and routines. There is no shared detect → decide → act → verify → log path for provider calls, so a poisoned NWS or mail sync cannot be dead-lettered and replayed. | Search of `packages/core/src` found no circuit breaker or dead-letter type. `engine/queue.ts` only enqueues `QUEUES.taskRun`. `ESCALATED` is a task state, not an integration DLQ. |
| P1-2 | 5×3×5×3×3÷2 ≈ 338 | Outbound HTTP has no allowlist. The only `fetch` in product code is `fetchNwsAlerts`, and it pins `https://api.weather.gov`. A later caller that passes a user URL would be SSRF. | `packages/core/src/speed/nws.ts` `alertsUrl` / `fetchNwsAlerts`. No `ssrf` helper. |
| P1-3 | 4×4×5×2×3÷2 ≈ 240 | Mutating `/api/trpc` does not check `Origin` against `Host`. Session cookies are the credential. SameSite is a browser default, not an explicit server check. | `apps/web/src/app/api/trpc/[trpc]/route.ts` passes the request straight to the tRPC adapter. No `middleware.ts`. |
| P1-4 | 4×3×5×2×4÷2 ≈ 240 | Tool contracts have Zod inputs and a tier, and no output schema or per-tool rate limit. A tool can return an unexpected shape that is stored on `workflow_executions.output` and may be shown later. | `engine/tools.ts` `ToolDefinition` has `args` and not `output`. `executor.ts` stores `output` unchecked. |
| P1-5 | 5×3×5×2×3÷2 ≈ 225 | Model tool calls are parsed with Zod and unknown names fail the task, but there is no single test that a hallucinated tool, a tier-2 handler on the bus, and a cross-tenant snapshot are all rejected. Inbound SMS and weather headlines are not in the injection fixtures. | `orchestrator.ts` `INVALID_ACTION`. `inbox.test.ts` covers email. `chat/read.ts` `workspaceSnapshot` is tenant-scoped only by the transaction the caller opens. |
| P1-6 | 3×4×3×4×4÷2 ≈ 288 | One provider serves every purpose. The ledger and monthly budget exist. A classify call and a plan call are not priced or routed differently, so a future live key would spend the strong model on deterministic work. | `engine/router.ts` `complete` uses `defaultProvider` and `req.model`. `billing/metering.ts` has one `modelPrices()` pair. |
| P1-7 | 4×4×4×3×3÷2 ≈ 288 | Logs and spans do not carry a correlation id, actor, agent, tool, input hash, duration, and recovery together. `withSpan` sets `tool` and `task.id` only. | `tracing.ts`, `logger.ts`. `executor.ts` warns with `tenantId`, `taskId`, `tool`, and the error string. |
| P1-8 | 4×2×4×3×3÷2 ≈ 144 | `/api/healthz` is database-only. An open breaker or a dead letter is invisible to an uptime check. | `apps/web/src/app/api/healthz/route.ts` |
| P1-9 | 3×3×4×2×2÷2 ≈ 72 | Failure-path tests exist for approvals, retries, and one worker crash (`worker.test.ts`). There is no in-process load smoke for duplicate and concurrent event keys, timeouts, or partial tool failure as a named suite. | `packages/core/test/worker.test.ts`, `engine.test.ts` |

## 5. Optimization opportunities (P2)

| ID | Score | Finding | Evidence | This pass |
|---|---|---|---|---|
| P2-1 | 3×3×2×2×3÷2 ≈ 27 | Hot queries already have tenant indexes (`tasks_tenant_state_idx`, `audit_events_tenant_seq_idx`). The audit action filter is `LIKE 'prefix%'` and has no `(tenant_id, action)` index. | `0001_init.sql`, `0002_engine.sql`, `0003_inbox.sql`, `audit-log/service.ts` | Measure with `EXPLAIN`. Propose the index in 0022. Do not apply it. |
| P2-2 | 2×2×1×1×3÷1 ≈ 12 | No recorded JS bundle budget. | `pnpm build` output lists routes, not byte sizes. | Record `.next` sizes in the second pass. No compaction. |
| P2-3 | 3×2×3×1×2÷2 ≈ 18 | `scrubPii` masks emails, not phone numbers sitting in free strings. | `logger.ts` `EMAIL_RE` only. | Mask digit-runs that look like phone numbers inside the scrubber. |
| P2-4 | 2×2×3×1×2÷2 ≈ 12 | No in-repo secret-pattern check. Redaction is runtime-only. | `REDACT_PATHS` in `logger.ts`. | A scanner plus a fixture test. Skip the scanner's own source so the patterns do not flag themselves. |
| P2-5 | 2×2×2×2×2÷3 ≈ 5 | Circuit-breaker state is per process. Two workers would not share an open breaker until 0022 is adopted. | Single `worker.ts`. | In-process breaker now. Proposed table for later. Document the limit. |

## 6. Missing capabilities (P3)

Not built this pass. Deterministic code is the better tool.

| ID | Item | Why deferred |
|---|---|---|
| P3-1 | A new “recovery agent” that diagnoses escalations with a model | `retryEscalatedTask` and the new replay path are deterministic. A model that suggests a retry does not change the outcome and can propose a forbidden send. |
| P3-2 | Answer-engine checks (`ai_answer_checks`) exposed as a product | Owner cost decision. The table exists; the provider is mock. |
| P3-3 | Live OTel collector, paging, multi-region | Needs an endpoint the owner chooses. `initOtel` already no-ops without one. No paid host. |
| P3-4 | Trademark search, pen-test, production SMTP/Gmail/Stripe certification | External or owner. Out of this branch. |
| P3-5 | Adopting proposed 0020, 0021, or 0022 | Darian reviews SQL. This branch does not apply migrations. |

## 7. Prioritization

Ship order: P0-1 (do not claim ready) → P1-1, P1-2, P1-3, P1-5, P1-4, P1-6, P1-7, P1-8, P1-9 → P2-1 through P2-4 while the tests are open. P2-5 and every P3 stay deferred.

## 8. Proposed architecture

No new agent. One deterministic pipeline in `packages/core/src/events/`, called by code, never by model text.

| Step | Behavior |
|---|---|
| Goal | One integration event is acted on once, or parked for a human replay. |
| Inputs | `tenantId`, `idempotencyKey`, `type`, `source`, a small scrubbed payload (no bodies, no addresses). |
| Tools | None from the model tool registry. Handlers are functions registered in code. `maxTier` must be 0 or 1. A handler above that is rejected before it runs. |
| Reasoning | None. `decide` is a pure function. |
| Actions | `act` may read or write inside the tenant. It may not send email, SMS, or money. |
| Validation | Zod on the event. Output of `act` checked. Breaker short-circuits when the integration is open. |
| Memory | Success is an audit row with the idempotency key (`audit_events_idem_idx`). Dead letters are audit rows `ops.dead_letter`. Proposed tables in 0022 are not read by the running app. |
| Output | `{ status: "done" \| "duplicate" \| "dead" \| "degraded", correlationId }`. |
| Failure | Exponential backoff, capped attempts, then dead letter. Breaker opens after repeated failures and half-opens after a cool-down. |
| Escalation | A manager replays from the Recovery page. Replay is tier 1, audited, and uses the same idempotency key so a success is still once. |

Model routing stays inside `ModelRouter`: purpose `classify` / `summarize` selects the cheap model name; `plan` selects the strong name. `WOS_MOCK_MODE` keeps the mock provider, so no network call is added. The existing budget hooks stay wrapped around `complete`.

Correlation: `AsyncLocalStorage` set at the tRPC and worker boundary. `logOp` writes who, agent, tool, sha256 of the canonical input, duration, outcome, recovery. It runs `scrubPii` first.

## 9. SQL impact (proposed, not applied)

`packages/db/proposed/0022_events_and_dead_letters.sql` plus a down file:

- `integration_events`, `dead_letters`, `integration_breakers`, each with `tenant_id` → `organizations`, `UNIQUE (tenant_id, id)`, forced RLS, `tenant_id = app_current_tenant()` policies, and grants for `app_user`.
- Index proposal `(tenant_id, action)` on `audit_events` for the prefix filter. Not applied, so today’s planner is unchanged.
- An isolation test applies 0022 inside a transaction and rolls it back, same pattern as `proposed-0021-isolation.test.ts`.

The running app keeps using `audit_events` until that file is moved into `migrations/` after review. 0020 and 0021 stay proposed.

## 10. Verification plan (SELF-ASSESSMENT)

After implementation, the author runs and records counts, not a grade:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test` (includes new event, SSRF, CSRF, tool-output, injection, and load-smoke tests)
- `pnpm test:isolation` (applied schema plus proposed 0021 and 0022, both rolled back)
- `pnpm build`
- `WOS_MOCK_MODE=1 pnpm test:e2e` if a page or route changed

OMEGA or Darian re-runs the same commands. Their counts are the verification.

## 11. Out of scope

- REA, competitor source, competitor UI.
- Loosening approval floors, auto-pay, live SMS, or a paid provider.
- Applying any migration, including 0022.
- Merge or deploy.
- A new model agent.
- Compacting the chat-first shell.

## 12. Second pass

**SELF-ASSESSMENT.** An independent check of `89c9d6f` was NO-GO. The notes below replace the earlier claim that the bus and the hardening were finished. Production stays NO-GO. 0020, 0021, and 0022 stay proposed and unapplied.

What `89c9d6f` overstated:

- The bus had no producer on the mail, CRM, payments, model, or weather paths, so Recovery stayed empty in normal operation.
- A timeout did not cancel the handler, and retries could apply the effect again.
- Dead-letter keys were cut from 200 characters to 196, and a successful replay left the letter listed.
- Error strings were logged and stored without secret redaction.
- The origin check compared hosts and trusted `X-Forwarded-Host`.
- Weather fetches followed redirects without checking the next host, and HTTP 503 did not open the breaker.
- The new injection test only checked tag escaping.

The follow-up on this branch wires those call sites, aborts timed-out work, checks the idempotency key at the effect, stores the full event key, marks a successful replay resolved, redacts secret-shaped text in errors, compares scheme+host+port to `APP_ORIGIN` / `BETTER_AUTH_URL`, re-checks every redirect, and counts 5xx and timeouts as breaker failures. Deeper tests cover inbound-email tool smuggling, a lead note that tries to instruct a send, and a model call that names another tenant.

Still true, and not claimed as done:

- The breaker and the effect-once set are per process. Two workers can still both pass `once` before either audit row commits. 0022 is the proposed shared table and is not applied, so it does not by itself fix that.
- `logOp` correlation is set on tRPC requests. The worker does not open that scope, and the bus result does not return a correlation id.
- Tool output schemas are strict for forgery and the new-destination payout. Other tools still use a passthrough object schema.
- Model routing picks a name. Billing still uses one price pair. No live model call was made, so there is no measured cost change.
- The query-shape test is `EXPLAIN` on an empty tenant, not `EXPLAIN ANALYZE` under load.
- Secret redaction is the logger and the dead-letter text. It is not a repository-wide CI scanner.

### What changed

| ID | Result |
|---|---|
| P0-1 | Still NO-GO. This branch does not say the product is production-ready. |
| P1-1 | `runEvent` is the pipeline. Weather fetch, inbox sync, mail draft/send, CRM writes, invoice create, and model complete go through it. A failure is dead-lettered. Replay uses the full event key and then records `ops.dead_letter.resolved`. Timed-out work is aborted and not retried. |
| P1-2 | `fetchAllowlisted` allowlists `https://api.weather.gov`, uses `redirect: "manual"`, and checks every hop. HTTP 503 and timeouts count as breaker failures. |
| P1-3 | POST `/api/trpc` and public booking POST must match `APP_ORIGIN` or `BETTER_AUTH_URL` (scheme, host, and port). `X-Forwarded-Host` is ignored. |
| P1-4 | Tool definitions carry an output schema. The executor checks it and enforces an optional per-tenant rate window. Forgery output must be `paid: false`. Payment-with-new-destination output must be `recorded_destination_only`. |
| P1-5 | Tests cover an email that smuggles a tool call, a lead note that tries to order a send, a model call that names another tenant, and a snapshot that does not contain the other tenant's note. |
| P1-6 | `modelForPurpose` picks a cheap model for classify/summarize/route and the strong model otherwise. Mock mode still selects no live model. The existing budget ledger is unchanged. |
| P1-7 | `logOp` writes correlation id, actor, agent, tool, input hash, duration, and outcome when a tRPC request set the scope. Error messages, causes, and stacks are scrubbed for secret-shaped text before they are logged. The worker does not open that scope. |
| P1-8 | `/api/healthz` still returns 503 when the database is down, and now includes `degraded` with the names of open breakers. |
| P1-9 | `packages/core/test/elite.test.ts` covers concurrent duplicates (25 callers, 1 act), backoff, timeout, tier-2 refusal, breaker open/half-open, and the rate limiter. |
| P2-1 | `EXPLAIN` on `wos_test`: open tasks use `tasks_tenant_state_idx`. The audit prefix filter uses `audit_events_tenant_seq_idx` and then filters `action`. The `(tenant_id, action)` index is proposed in 0022 and was not created. |
| P2-2 | Production client static assets are 976K. Largest chunk is 229,389 bytes. The `.next` directory is 530M because it includes the server build, not the browser payload. Today lab metrics in e2e stayed CLS 0.04, LCP 100ms, INP 24ms. |
| P2-3 | Phone-shaped numbers in free strings are replaced with `[phone]`. |
| P2-4 | `secretFindings` flags live/test Stripe-shaped keys, AWS access-key shapes, private-key banners, and SendGrid-shaped tokens. A fixture test covers it. |
| P2-5 | Deferred. The breaker is per process. Two workers would not share an open circuit until 0022 is applied. |

### Deferred, and why

- Applying 0020, 0021, or 0022. Darian reviews SQL. The bus is real on `audit_events` until then.
- A recovery agent. Replay is deterministic. A model that suggests a send would be a new way to skip the approval floor.
- A live collector, paging, pen-test, trademark search, or a paid model call.
- Multi-instance breaker state (P2-5), for the reason above.

### Commands (self-assessment after the follow-up)

- `pnpm lint` — pass
- `pnpm typecheck` — pass
- `pnpm test` — 731 passed (59 files); migrate reported 19 files
- `pnpm test:isolation` — 18 passed (15 applied, 2 proposed 0021, 1 proposed 0022, both rolled back)
- `pnpm build` — pass (Next.js 16.4.5)
- `WOS_MOCK_MODE=1 pnpm test:e2e` — 45 passed (about 5.0m), including axe

These counts are not an independent grade. 0020, 0021, and 0022 were not applied.

## 13. Third pass

**SELF-ASSESSMENT.** An independent check of `fc08116` was still NO-GO. The producer wrote `integration.nws` and replay only knew `weather.refresh`, so an owner replay returned CONFLICT. A second run of a timed-out key could apply the effect again. Provider-key shapes and a nested `token` field still reached the log. Malformed JSON did not open the breaker. Two concurrent producers with one key returned one success and one error.

This pass registers `integration.nws`, `integration.mail`, `integration.crm`, `integration.payments`, and `integration.model`. Weather replay refetches. The other four do not repeat the external action. A successful effect is remembered for the process, and a replay of that key is a no-op success. Concurrent callers of the same key share one result. Redaction walks the whole object and covers `sk-`, `sk-ant-`, `xai-`, `AIza`, `ghp_`, JWTs, and Bearer tokens. JSON parse errors count as breaker failures. Inbox listing goes through the mail producer.

Still not true: the applied-effect map and the breaker do not cross processes. Replaying mail, CRM, payments, or the model does not rebuild the original call. 0022 is still only a proposal. Production stays NO-GO.

### Commands after this pass

- `pnpm lint` — pass
- `pnpm typecheck` — pass
- `pnpm test` — 731 passed (59 files); migrate reported 19 files
- `pnpm test:isolation` — 18 passed
- `pnpm build` — pass
- `WOS_MOCK_MODE=1 pnpm test:e2e` — 45 passed (5.0m)

Self-assessment only.
