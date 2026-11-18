// task.continue: bounded follow-up chains. The follow-up is a fresh task that
// re-runs the full classify → plan → policy → approval pipeline; the tool only
// creates it, with hard caps on depth, fan-out and chain size.
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvents, closePool, tasks, withTenant } from "@wos/db";
import { continuationOf, createOrg, createTask, insertTask, stopBoss, taskContinueTools, ToolError } from "../src/index";
import type { ToolContext, ToolDefinition } from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

let orgId: string;
let rootTaskId: string;

const tool = taskContinueTools()[0] as ToolDefinition<{ intent: string; summary: string }, { taskId: string; queued: true }>;
const ctx = (taskId: string): ToolContext => ({ tenantId: orgId, taskId, agentId: "agent-test", idempotencyKey: `k-${taskId}` });

async function readTask(taskId: string) {
  return withTenant(orgId, async (tx) => (await tx.select().from(tasks).where(eq(tasks.id, taskId)))[0]!);
}

async function continueTask(taskId: string, intent = "keep going", summary = "what we learned") {
  return tool.execute(ctx(taskId), { intent, summary });
}

async function expectRefusal(taskId: string, code: string): Promise<void> {
  const err: unknown = await continueTask(taskId).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ToolError);
  expect((err as ToolError).code).toBe(code);
  expect((err as ToolError).retryable).toBe(false);
}

beforeEach(async () => {
  await resetDb();
  await seedUser("owner", "owner@example.test");
  orgId = (await createOrg({ actorUserId: "owner", name: "Chain Co" })).orgId;
  rootTaskId = (await createTask({ actorUserId: "owner", orgId, intent: "start the work" })).taskId;
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("task.continue", () => {
  it("queues a follow-up attributed to the original requester, with the handoff in its input", async () => {
    const { taskId, queued } = await continueTask(rootTaskId, "chase the unpaid invoice", "invoice inv_1 is 30 days overdue");
    expect(queued).toBe(true);

    const followUp = await readTask(taskId);
    expect(followUp.requestedBy).toBe("owner"); // the person, not the agent
    expect(followUp.parentTaskId).toBe(rootTaskId);
    expect(followUp.intent).toBe("chase the unpaid invoice");
    expect(followUp.state).toBe("REQUESTED"); // full pipeline re-runs from the start
    expect(followUp.plan).toBeNull(); // no plan is inherited — the new task plans itself
    const cont = continuationOf(followUp.input);
    expect(cont).toMatchObject({ chainId: rootTaskId, depth: 1, fromTaskId: rootTaskId, summary: "invoice inv_1 is 30 days overdue" });
  });

  it("audits the handoff with the chain provenance and the agent behind it", async () => {
    const { taskId } = await continueTask(rootTaskId);
    const rows = await withTenant(orgId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.target, `task:${taskId}`)),
    );
    const created = rows.find((r) => r.action === "task.create");
    expect(created).toBeDefined();
    expect(created!.metadata).toMatchObject({ via: "task.continue", fromTaskId: rootTaskId, chainId: rootTaskId, depth: 1, agentId: "agent-test" });
  });

  it("refuses to continue past the depth cap, without retrying", async () => {
    const d1 = (await continueTask(rootTaskId)).taskId;
    const d2 = (await continueTask(d1)).taskId;
    expect(continuationOf((await readTask(d2)).input)!.depth).toBe(2);

    await expectRefusal(d2, "CHAIN_DEPTH_LIMIT");
  });

  it("refuses a fourth follow-up from the same task", async () => {
    for (let i = 0; i < 3; i++) await continueTask(rootTaskId);
    await expectRefusal(rootTaskId, "CHAIN_FANOUT_LIMIT");
  });

  it("refuses to grow a chain past the total size cap", async () => {
    // root + 3 children + 3 grandchildren (under child 1) + 1 (under child 2) = 8 = cap.
    const children: string[] = [];
    for (let i = 0; i < 3; i++) children.push((await continueTask(rootTaskId)).taskId);
    for (let i = 0; i < 3; i++) await continueTask(children[0]!);
    await continueTask(children[1]!);

    await expectRefusal(children[2]!, "CHAIN_SIZE_LIMIT");
  });

  it("counts one chain per org — another org's tasks never affect the caps", async () => {
    // A different org with its own chain at the caps still leaves this org untouched.
    await seedUser("other", "other@example.test");
    const otherOrg = (await createOrg({ actorUserId: "other", name: "Other Co" })).orgId;
    await withTenant(otherOrg, async (tx) => {
      for (let i = 0; i < 3; i++) {
        await insertTask(tx, {
          orgId: otherOrg,
          actorUserId: "other",
          intent: "x",
          input: { continuation: { chainId: rootTaskId, depth: 1, fromTaskId: rootTaskId, summary: "s" } },
        });
      }
    });
    // Same chainId values, but in another tenant: our fan-out count is still 0.
    const { taskId } = await continueTask(rootTaskId);
    expect(continuationOf((await readTask(taskId)).input)!.depth).toBe(1);
  });

  it("callers cannot forge continuation provenance through the API path", async () => {
    const { taskId } = await createTask({
      actorUserId: "owner",
      orgId,
      intent: "x",
      input: { continuation: { chainId: "forged", depth: 0, fromTaskId: "forged", summary: "forged" } },
    });
    expect(continuationOf((await readTask(taskId)).input)).toBeUndefined();
  });
});
