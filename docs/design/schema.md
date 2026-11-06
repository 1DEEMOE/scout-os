# Database Schema

Source of truth: `packages/db/migrations/0001`–`0007` (tables, RLS policies, grants, checks). `packages/db/src/schema.ts` mirrors it for typed queries. A fresh database applies all seven in order (verified 2026-11-03).

## Roles

| Role | Used by | Rights |
|---|---|---|
| `wos_owner` | Migrations only | Owns all tables and the job queue schema. Still subject to RLS (FORCE). |
| `app_user` | Web server and worker | No superuser, no BYPASSRLS, owns nothing. Grants below. |

## Context settings

| Setting | Set by | Effect |
|---|---|---|
| `app.tenant_id` | `withTenant(id, fn)` | Tenant tables show and accept only that tenant's rows |
| `app.user_id` | `withUser(id, fn)` (no tenant) | Shows only that user's memberships and their organizations |
| neither | `withGlobal(fn)` | Tenant tables show nothing; global tables usable |

Both are transaction-local (`set_config(..., true)`) and tested not to leak through the connection pool.

## Tenant tables (RLS enabled and forced, policy `tenant_id = app_current_tenant()`)

S/I/U/D = SELECT/INSERT/UPDATE/DELETE granted to `app_user`. Child tables use composite foreign keys `(tenant_id, parent_id)`, so a row can't reference another tenant's parent.

| Table | Migration | Grants | Notes |
|---|---|---|---|
| organizations | 0001 | S/I/U | Row = tenant. Also visible in user context to its members. `monthly_ai_budget_micros` (0007). |
| organization_members | 0001 | S/I/U/D | PK (tenant_id, user_id); owner/admin/member/viewer |
| audit_events | 0001 | **S/I** | Append-only. `seq` bigserial (0003) gives stable order. Unique (tenant_id, idempotency_key). |
| agents | 0002 | S/I/U | One per kind per tenant |
| agent_versions | 0002 | **S/I** | Immutable |
| agent_permissions | 0002 | S/I/U/D | (agent, tool) → max tier |
| tasks | 0002 | S/I/U | State machine; `version` for optimistic locking |
| task_dependencies | 0002 | S/I/U/D | |
| workflow_executions | 0002 | S/I/U | One row per step attempt; idempotency key |
| approval_requests | 0002 | S/I/U | Bound to `action_digest` (sha256). Checks: tier 4 can't be approved/consumed without `confirmed_at`; consumed needs `consumed_at`. One open request per digest. |
| integration_connections | 0003 | S/I/U | `secret_ciphertext` = AES-256-GCM, key outside the DB, bound to (tenant, connection) |
| email_identities | 0003 | S/I/U | `mode` draft_only (default) / send_with_approval |
| conversations | 0003 | S/I/U | Draft fields hold the pending reply |
| messages | 0003 | **S/I** | Unique (tenant_id, external_id) |
| contacts | 0004 | S/I/U | Unique (tenant_id, lower(email)) |
| crm_records | 0004 | S/I/U | Deals; amount in integer cents |
| invoices | 0005 | S/I/U | Integer cents; status; due_date |
| memory_records | 0006 | S/I/D | Check: org layer only with trust user/verified. Full-text index. |
| subscriptions | 0007 | S/I/U | Platform billing state from Stripe webhooks |
| usage_events | 0007 | **S/I** | Model tokens and tool calls; cost in micro-dollars |
| billing_ledger | 0007 | **S/I** | One usage entry per month; unique Stripe refs |
| chat_threads | 0008 | S/I/U | Owner ↔ lead bot conversations. `updated_at` for ordering. |
| chat_messages | 0008 | **S/I** | Append-only. `author_type` user/lead (user ⇔ `author_user_id`). `provider`/`model`/`mock` on lead replies. Unique (tenant_id, thread_id, client_ref) dedupes a double-sent message. |
| chat_delegations | 0008 | **S/I** | Lead reply → task it created. Unique (tenant_id, task_id). |

0008 also adds `approval_requests_distinct_confirmer`: `confirmed_by` must differ from `decided_by` (tier 4 needs two different people).

### Lead bot delegation (M12)

- The lead bot has exactly one tool, `delegate {agent: inbox|sales|finance, request}`. Each accepted call creates an ordinary task (`input.agentKind`, `input.delegation = {chainId, depth: 1, threadId}`, `input.chatMessage`), so planning, policy, approvals and execution are unchanged. Delegated agents can't delegate (depth 1); at most 3 hand-offs and one per agent per turn; refused hand-offs are audited `chat.delegate`/denied.
- `input.delegation` is stripped from user-supplied task input; only the chat service sets it.
- Effective grant of delegated work = agent grant ∩ lead ceiling (tier 3, so tier 4 is never delegated) ∩ the requester's role, re-read at policy time (owner/admin 4, member 2, viewer none).
- `chainId` (the lead reply id) is part of the approval's `action_digest` and payload; changing it after approval fails the step with DIGEST_MISMATCH. Digests of non-delegated actions are unchanged.
- Provenance: a step argument containing an email address or URL that also appears in external data (task input, chat text) is listed in the approval payload as `externalDataFields`. Such a step is raised to tier 2 (human approval) even if its tool is tier 0–1, in every task (owner decision, 2026-11-04). Consequence: saving a lead from an email (contact, deal, note with the sender's address) now needs one approval per step; no exemption for the sender's own address.
- Approvals: the requester of a task can't approve its tier 2+ steps unless they are the org's only owner/admin (audited `selfApprovalWaiver: sole_manager`). The tier 4 confirmation must come from a different owner than the approver.

### Session 5 additions (migration 0009, additive; rollback in `packages/db/rollback/0009_review.down.sql`)

| Column | Table | Purpose |
|---|---|---|
| `title` | tasks | Short label for people. `intent` stays the full instruction the agent receives. Never sent to the model. |
| `agents_paused_at`, `agents_paused_by` | organizations | Kill switch. Both set or both null (check constraint). While set, the engine takes no step and the lead bot hands nothing off. Owner-only, audited as tier 4. |

### Scout Phase 3 additions (migration 0010, additive; rollback in `packages/db/rollback/0010_entitlements.down.sql`)

- `usage_counters (tenant_id, metric, period 'YYYY-MM', used, updated_at)`, PK `(tenant_id, metric, period)`. Metric is checked against `tasks`, `scout.opportunities`, `scout.prospect_rows`. Grants: SELECT, INSERT, UPDATE (no DELETE). Consumed only by `consumeQuota`: one `INSERT … ON CONFLICT DO UPDATE … WHERE used + n <= limit RETURNING used` statement, so concurrent callers can't exceed the limit.
- `subscriptions.last_event_at timestamptz`: time of the newest Stripe event applied. Older events are ignored, so a late `active` can't undo a cancellation.
- `organizations.plan` (existing column) is now read: written only by the Stripe webhook (price → plan via `STRIPE_PRICE_PLAN_MAP`) or `operatorSetPlan` (not in the API). Legacy `free` reads as `starter`; no data rewritten.

### Scout Phase 4 additions (migration 0011, additive; rollback in `packages/db/rollback/0011_scout.down.sql`, round trip tested)

All forced RLS with the standard tenant policy, composite FKs, seeded in the isolation test.

| Table | Notes | App grants |
|---|---|---|
| `business_profiles` | One per org (`UNIQUE (tenant_id)`); `status` draft/reviewed with a check that reviewed rows carry reviewer and time | SELECT, INSERT, UPDATE |
| `intelligence_sources` | `kind` SPC / CRM / customer import; check: an import must carry attestation, attested_by, attested_at | SELECT, INSERT, UPDATE (row count) |
| `signal_observations` | Storm reports, no personal data; `UNIQUE (tenant_id, external_ref)` dedupes re-uploads | SELECT, INSERT |
| `prospects` | Allow-listed columns only; `UNIQUE (tenant_id, dedupe_key)`; `retention_until` NOT NULL | SELECT, INSERT, DELETE (retention purge only) |
| `opportunities` | Stage check; disqualified ⇔ reason; qualified/opportunity need `qualification`; partial unique index = one open per prospect + vertical | SELECT, INSERT, UPDATE |
| `opportunity_events` | Append-only stage history with evidence | SELECT, INSERT |
| `communication_permissions` | Per channel; basis in existing_customer / inbound_inquiry / express_written_consent; one active per address; revoke = set revoked_* | SELECT, INSERT, UPDATE |
| `suppression_list` | `UNIQUE (tenant_id, channel, value)`, lower-case values; never removed by the app | SELECT, INSERT |
| `outreach_events` | sent / blocked (blocked ⇔ reason) | SELECT, INSERT |

`agents.kind` check now allows `scout`.

## Global tables (no tenant data)

| Table | Grants | Why global |
|---|---|---|
| users | S/I/U/D | Identity spans organizations |
| auth_sessions, auth_accounts, auth_verifications | S/I/U/D | Auth library storage (ADR-003); `auth_accounts.password` is a hash |
| webhook_events | S/I | Replay protection; events arrive before the tenant is known; holds only provider event ids |
| schema_migrations | owner only | Migration bookkeeping |
| `pgboss.*` | S/I/U/D | Job queue (ADR-001). Job payloads hold only tenant and task ids. |

## Rules for new tables

1. Tenant data: `tenant_id uuid NOT NULL`, composite FKs to parents, `ENABLE` + `FORCE ROW LEVEL SECURITY`, the standard policy, minimal grants.
2. Add a seed row in `packages/db/test/isolation.test.ts`. The test discovers every table with a `tenant_id` column and fails until the new table is both protected and seeded.
3. Every new API procedure is covered by `apps/web/test/all-endpoints-isolation.test.ts` automatically.
