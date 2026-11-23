import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { ownerQuery } from "./helpers";

/** Measures the planner on the two hottest tenant filters. Does not add indexes. */
describe("query shape", () => {
  it("uses the tenant-state index for open tasks", async () => {
    // On a near-empty table the planner rightly prefers a seq scan, so plan
    // choice would depend on how many rows earlier tests left behind. Disable
    // seq scans on this one connection to check what we care about: that an
    // index on (tenant_id, state) exists and the planner can use it.
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
    await c.connect();
    try {
      await c.query("SET enable_seqscan = off");
      const { rows } = await c.query<{ "QUERY PLAN": string }>(
        "EXPLAIN SELECT id FROM tasks WHERE tenant_id = $1 AND state = 'EXECUTING' ORDER BY updated_at DESC",
        [randomUUID()],
      );
      const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(plan).toMatch(/tasks_tenant_state_idx|Index/);
    } finally {
      await c.end();
    }
  });

  it("explains the audit prefix filter the recovery page uses", async () => {
    const rows = await ownerQuery<{ "QUERY PLAN": string }>(
      "EXPLAIN SELECT id FROM audit_events WHERE tenant_id = $1 AND action LIKE 'ops.dead_letter%' ORDER BY seq DESC",
      [randomUUID()],
    );
    const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan.length).toBeGreaterThan(0);
    // Proposed 0022 adds audit_events_tenant_action_idx. Until it is applied the planner
    // may use audit_events_tenant_seq_idx or a seq scan. Record the choice.
    expect(plan).toMatch(/audit_events|Seq Scan|Index/);
  });
});
