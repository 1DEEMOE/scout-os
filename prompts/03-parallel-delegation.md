This milestone has independent workstreams. Delegate as follows.

If you have subagents/background agents (Claude Code: spawn them; Cursor:
use background agents; otherwise: do the workstreams sequentially in the
order listed and note the fallback in session-log.md):

Workstream split for [milestone name]:
- Agent 1 "backend": [files/contracts it owns]. May NOT touch [X].
- Agent 2 "frontend": [files/contracts it owns]. May NOT touch [X].
- Agent 3 "tests/security": adversarial review of 1 & 2 — tenant
  isolation, injection, approval-bypass attempts.

Rules for agents:
1. Each works only on its owned files; shared interfaces are frozen in
   docs/design/ before work starts.
2. No agent merges its own high-risk changes. All Tier 2+ behavior gets
   independent review from the tests/security agent.
3. If worktrees/parallel execution are unavailable, say so explicitly and
   run sequentially. Never fabricate parallel execution or its results.

Consolidate: run the full verified command suite on the merged result and
report real outputs.
