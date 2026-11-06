# ADR-001: Orchestration engine for the MVP

Status: PROPOSED (needs owner approval)
Date: 2026-11-03

## Context

Tasks must survive worker restarts, retry with backoff, wait days for human approval, and never double-execute external actions. One developer operates the system, so operational cost matters as much as features.

## Options

| | pg-boss (Postgres-backed queue) | Temporal |
|---|---|---|
| Extra infrastructure | None — uses our Postgres | Temporal server + its DB, or Temporal Cloud |
| Cost at MVP scale | $0 beyond Postgres | Self-host: another service to run and upgrade. Cloud: usage-based fee. |
| Durability | Jobs in Postgres; survive restarts | Full event-sourced history; replays workflow code |
| Long waits (approvals) | Model as state in `tasks` + a scheduled job | Native timers and signals |
| Transactional with app data | Yes — enqueue in the same transaction as the state change | No — needs outbox pattern |
| Learning curve | Low | Higher (determinism rules for workflow code) |
| License | MIT | MIT |

## Decision

**Use pg-boss for the MVP.** Our state machine already lives in `tasks` and `workflow_executions`, so we need a reliable "run this step" queue, not a workflow engine. Enqueuing in the same transaction as the state change removes a whole class of lost-job bugs.

## Consequences

- We own retry, backoff, and step-history logic (small, tested in Milestone 2).
- Revisit if any of these happen: workflows exceed ~10 steps with branching, queue throughput becomes a Postgres bottleneck, or we need cross-region workers. Temporal is the upgrade path; the `transition()` + step-key design ports cleanly.
