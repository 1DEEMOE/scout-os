// Milestone 2 acceptance: one task through classify -> plan -> policy ->
// approval -> execute -> complete, using the real queue and worker but MOCK
// model and MOCK tools (no external system is touched). Prints the audit trail.
// Run from packages/core: DATABASE_URL=... npx tsx scripts/acceptance-m2.ts
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { closePool, withGlobal, withTenant } from "@wos/db";
import {
  configureEngine, createAgent, createOrg, createTask, decideApproval, handleTaskRunJob, listApprovals,
  MockLedger, MockModelProvider, mockTools, ModelRouter, startTaskWorker, stopBoss, stopTaskWorker, ToolRegistry, getTask,
} from "../src/index";

const ledger = new MockLedger();
configureEngine({
  router: new ModelRouter([new MockModelProvider((r) => r.purpose === "classify"
    ? { text: "inbox" }
    : { text: "Replying to the client.", toolCalls: [
        { name: "mock.lookup", input: { q: "client history" } },
        { name: "mock.send_email", input: { to: "client@example.test", subject: "Re: invoice", body: "Attached." } },
      ] })], "mock"),
  tools: new ToolRegistry().register(...mockTools(ledger)),
});

const userId = `accept-${randomUUID().slice(0, 8)}`;
await withGlobal((tx) => tx.execute(sql`INSERT INTO users (id, name, email) VALUES (${userId}, 'Acceptance Owner', ${userId + "@example.test"})`));
const { orgId } = await createOrg({ actorUserId: userId, name: "M2 Acceptance (synthetic)" });
await createAgent({ actorUserId: userId, orgId, spec: { kind: "inbox", displayName: "Inbox", instructions: "Handle mail.",
  tools: [{ name: "mock.lookup", maxTier: 0 }, { name: "mock.send_email", maxTier: 2 }] } });
await startTaskWorker(handleTaskRunJob, { pollingIntervalSeconds: 0.5 });

const wait = async (want: string) => {
  for (let i = 0; i < 100; i++) {
    const { task } = await getTask({ actorUserId: userId, orgId, taskId });
    if (task.state === want) return task;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`never reached ${want}`);
};

const { taskId } = await createTask({ actorUserId: userId, orgId, intent: "Reply to the client about their invoice" });
await wait("WAITING_FOR_APPROVAL");
console.log(`waiting for approval; external calls so far: ${ledger.calls}`);
const [ap] = await listApprovals({ actorUserId: userId, orgId, status: "pending" });
console.log(`approval request: "${ap!.summary}" (tier ${ap!.tier}, digest ${ap!.actionDigest.slice(0, 12)}...)`);
await decideApproval({ actorUserId: userId, orgId, approvalId: ap!.id, decision: "approve" });
const done = await wait("COMPLETED");
console.log(`task ${done.state}; MOCK external effects: ${ledger.effects.size}`);

const trail = await withTenant(orgId, (tx) => tx.execute(sql`SELECT actor_type, action, outcome, tier, metadata FROM audit_events ORDER BY at, id`));
console.log("\nAudit trail:");
for (const r of trail.rows as { actor_type: string; action: string; outcome: string; tier: number; metadata: Record<string, unknown> }[]) {
  const m = r.metadata as { from?: string; to?: string };
  console.log(`  ${r.actor_type.padEnd(7)} ${r.action.padEnd(22)} tier ${r.tier}  ${r.outcome}${m.from ? `  ${m.from} -> ${m.to}` : ""}`);
}
await stopTaskWorker();
await stopBoss();
await closePool();
