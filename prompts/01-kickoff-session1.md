Read CLAUDE.md (or .cursor/rules/workforce-os.mdc) fully before acting.
This is Session 1 of the WORKFORCE OS build. Execute EXACTLY these steps,
in order, and STOP at the gate at the end.

## Step 1 — Environment and tool discovery (30 min max)

1. Inspect this repository: structure, existing code, package manifests,
   configs, CI, deployment files. Summarize what already exists vs. what
   is greenfield.
2. Enumerate the MCP servers and tools actually available to you right
   now (check your MCP configuration; list each server and its tools).
   Do the same for other capabilities: web access, browser automation,
   shell, background agents/subagents, git worktrees.
3. Write docs/research/capability-matrix.md: every capability, confirmed
   available / unavailable / untested, and which Phase-1 research tasks it
   unblocks. Mark anything you cannot verify as UNVERIFIED, never assumed.

## Step 2 — Competitive and clean-room research (use only confirmed tools)

1. Research Bops (bops.bot + github.com/OrgoAI/bops): product surface,
   agent onboarding, team/delegation model, computer-use sessions, memory,
   approvals, pricing, license terms. Record source URL, date, confidence,
   and explicit unknowns for every claim. Separate verified behavior from
   marketing copy.
2. Research 4 adjacent competitors (Lindy, Relevance AI, n8n, CrewAI) on
   the 12 criteria: onboarding ease, workflow depth, agent collaboration,
   computer-use reliability, memory, phone/email, transparency/control,
   cost predictability, SMB fit, white-label, deployment flexibility,
   integrations.
3. Write docs/research/competitive-intelligence.md with the matrix and a
   prioritized differentiation strategy for ONE initial segment
   (recommend one of: solopreneurs / small service businesses, with
   reasons).
4. Write docs/research/license-register.md with every dependency you
   expect to use and its license. Note the Bops FSL constraint explicitly.

## Step 3 — Architecture proposal

Write docs/design/architecture-v1.md containing:
- Component diagram (frontend, API, workers, orchestrator, model router,
  memory layer, computer-use abstraction, Stripe) with trust boundaries.
- The core data model (tables from the approved list below) with tenant
  boundaries, keys, and RLS strategy:
  users, organizations, organization_members, subscriptions, usage_events,
  agents, agent_versions, agent_permissions, tasks, task_dependencies,
  workflow_executions, approval_requests, integration_connections,
  email_identities, conversations, messages, contacts, crm_records,
  invoices, memory_records, audit_events, billing_ledger.
- The task lifecycle state machine (REQUESTED → CLASSIFIED → PLANNED →
  POLICY_CHECKED → ASSIGNED → EXECUTING → VERIFYING → COMPLETED, plus
  WAITING_FOR_APPROVAL / RETRY_SCHEDULED / ESCALATED / FAILED /
  COMPENSATING) with persistence semantics.
- Orchestration ADR: Temporal vs. Postgres-backed queue — pick one for
  the MVP with explicit reasoning about operational cost.
- Threat model: prompt injection, cross-tenant leakage, credential
  exfiltration, webhook replay, memory poisoning, approval-replay.
  State the mitigation for each and WHERE it is enforced in code.

## Step 4 — Milestone plan

Write docs/plans/mvp-roadmap.md: break this MVP scope into independently
testable milestones, each ≤ 3 days of agent work, ordered by dependency:
1. Auth + organization onboarding (RLS-proven tenant isolation)
2. Agent registry + Chief-of-Staff orchestrator (task lifecycle only)
3. Inbox specialist + Gmail integration (draft-first mode)
4. Sales/CRM specialist + one CRM integration
5. Finance specialist + one invoicing integration
6. Approval center + audit log UI
7. Tenant-isolated memory (working + organizational layers only)
8. Command dashboard + usage metering + Stripe billing
Explicitly defer: phone/SMS, white-label, dedicated per-agent computers.
For each milestone: deliverables, interface contracts, tests required,
and the acceptance command output that proves it works.

## STOP GATE — do not write product code in this session

End by writing docs/plans/session-log.md summarizing: what you verified
(with commands/tool calls), what you could not verify, open questions for
me, and the single recommended first milestone. Then STOP and wait for my
approval of the architecture and roadmap before any implementation.
