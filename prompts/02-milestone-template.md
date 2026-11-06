Read the project rules file and docs/plans/mvp-roadmap.md first.

Milestone: [number and name from mvp-roadmap.md]
Scope: [paste the milestone's deliverables + interface contracts only]
Out of scope: everything else in the roadmap. Do not pull future work
into this session.

Before coding:
1. Re-state the interface contracts you will implement against.
2. List the files you expect to create/modify.
3. If anything in the contracts is ambiguous or contradicts existing
   code, STOP and ask me.

While coding:
- Follow the Definition of Done in the rules file exactly.
- Write tests alongside each unit of behavior, not at the end.
- Every new endpoint gets a tenant-isolation test proving tenant A
  cannot read/write tenant B's data.
- Commit in small increments with clear messages.

Before claiming completion:
1. Run the verified commands from the rules file (install, lint,
   typecheck, test, build) and paste the actual outputs.
2. Demonstrate the milestone's acceptance workflow end to end with
   synthetic data (sandbox/test keys only — never real customer data).
3. Update docs/plans/session-log.md: what works, what is mocked,
   deviations from the plan, and why.
4. Update the roadmap status for this milestone.

STOP GATE: end with a summary and wait for my review. Do not start the
next milestone in this session.
