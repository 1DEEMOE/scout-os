# SCOUT OS — Project Rules (AD22 OMEGA v2)


Customer-facing product name: **Scout OS**. Internal identifiers remain `@wos/*`, `WOS_*`, `wos_*` (packages, env, DB roles, HubSpot property). Trademark search for "Scout OS" is still required before public use.

## What this project is

A multi-tenant SaaS where SMB customers hire specialized AI employees
(orchestrator, inbox, sales, finance, scheduling, reporting) that collaborate
on real business workflows with human approval gates. Reference competitor:
Bops (https://bops.bot / github.com/OrgoAI/bops) — research only, see
clean-room rules below.

## Non-negotiable laws (apply to every session, every file)

1. Research before implementation. No architecture decisions without a
   written rationale in docs/design/.
2. No fabricated functionality. If a tool, API, MCP server, or integration
   is not actually available, say so and build a documented stub behind an
   interface — never pretend it works.
3. Every feature requires: working backend, authorization checks,
   persistence, structured logging, and automated tests. No exceptions.
4. Every external action (email, SMS, payment, CRM write) must be
   authenticated, authorized, idempotent, attributable in the audit log,
   and gated by the risk-tier approval policy below.
5. Least privilege for every agent, service, and integration. No shared
   god-credentials. No cross-tenant data access, ever.
6. Never claim production readiness without the acceptance evidence in
   docs/plans/acceptance.md. Mocks are labeled MOCK in code and UI.
7. Never overwrite or migrate existing data without a backup and a tested
   rollback path.
8. If you lack a capability (no browser tool, no network, no MCP server),
   state the limitation and execute the same work sequentially/manually.

## Clean-room rules (legal — do not relax)

- Bops source is FSL-licensed and treated as off-limits for competitive reuse.
- Do NOT copy Bops source files, UI assets, branding, prompt text, or
  distinctive implementation details. Public behavior and general concepts
  are research inputs only.
- Every dependency must have a license permitting commercial SaaS use.
  Maintain docs/research/license-register.md (name, version, license, use).
- Flag any unresolved IP question in docs/research/ip-flags.md instead of
  guessing.

## Local tooling note: REA MCP

An `rea` reverse-engineering MCP server (decompilers, Frida, bundle/web
capture) is installed on the owner's machine. Permitted uses: inspecting
OUR OWN builds and debugging this project. Forbidden: running it against
Bops (source, bundles, binaries, network traffic) or any competitor's
non-public artifacts. That would violate the clean-room rules above.

## Risk tiers and approval policy (enforce in code, not prompts)

- Tier 0 read-only: allowed autonomously.
- Tier 1 internal writes (drafts, notes, tags): allowed, logged.
- Tier 2 external communication (email/SMS/quotes/calendar invites):
  human approval required by default.
- Tier 3 financial/contractual (payments, refunds, pricing commitments):
  always human approval, no policy override.
- Tier 4 destructive/privileged (deletion, access changes, secrets):
  always human approval + second confirmation.
Policy enforcement lives in platform code outside the LLM. A model's own
instructions are never the enforcement mechanism.

## Tech stack (ratified — do not change without an ADR in docs/design/)

- Frontend: Next.js + React + TypeScript + Tailwind (App Router).
- Backend: TypeScript services, REST/tRPC API layer, background workers.
- Database: PostgreSQL with row-level tenant isolation. All tenant-scoped
  tables carry tenant_id and are covered by RLS or an equivalent enforced
  query layer.
- Orchestration: durable workflow execution (evaluate Temporal vs.
  Postgres-backed job queue in docs/design/orchestration-adr.md before
  building — simplest option that survives worker restarts wins).
- AI: provider-independent model router behind a single internal interface.
- Computer use: provider-agnostic abstraction (Browserbase/E2B/Daytona
  evaluation lives in docs/design/computer-use-adr.md). APIs first;
  computer use only for UI-only workflows. Never bypass CAPTCHA/MFA.
- Payments: Stripe Billing. Observability: OpenTelemetry + structured logs.

## Verified commands (the agent MUST run these before claiming done)

- Install:  `pnpm install`
- Test:     `pnpm test` (needs Postgres; see README) and `pnpm test:isolation`
- Lint/typecheck: `pnpm lint && pnpm typecheck`
- Build:    `pnpm build`

## Definition of Done (every task, no exceptions)

A task is complete ONLY when all are true:
1. Code compiles; lint, typecheck, and the full test suite pass.
2. New behavior has unit tests; cross-service behavior has integration tests.
3. Authorization and tenant-isolation tests exist for every new endpoint.
4. External actions have idempotency keys and audit-log entries.
5. Errors are typed, logged with context, and surfaced to the UI honestly.
6. Relevant docs updated (schema changes → docs/design/schema.md).
7. A short summary states what was verified and HOW (commands run, outputs).

## Artifact registry (write outputs here, nowhere else)

- docs/research/    competitor analysis, capability matrix, license register
- docs/design/      architecture, ADRs, schema, workflow specs, threat model
- docs/plans/       milestone plans, acceptance criteria, readiness reports
- docs/commercial/  packaging, unit economics, pricing model

## Working agreements

- Small commits, one concern each, imperative messages.
- Prefer editing existing files; justify every new file.
- When context is running low, write current state + next step to
  docs/plans/session-log.md before continuing.
- Ask the human instead of guessing on: naming/branding, pricing numbers,
  provider selection with cost impact, anything Tier 3+.
