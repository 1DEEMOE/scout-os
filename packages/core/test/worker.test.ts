import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import { createTask, decideApproval, handleTaskRunJob, startTaskWorker, stopBoss, stopTaskWorker } from "../src/index";
import { approvalsFor, setupHarness, taskRow, type Harness } from "./engine-helpers";

// Uses the real pg-boss queue and a real worker loop in this process.

let h: Harness;

async function waitFor(orgId: string, taskId: string, states: string[], timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await taskRow(orgId, taskId);
    if (states.includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`task ${taskId} stuck in ${(await taskRow(orgId, taskId)).state}`);
}

beforeAll(async () => {
  await startTaskWorker(handleTaskRunJob, { pollingIntervalSeconds: 0.5 });
});

beforeEach(async () => {
  h = await setupHarness();
});

afterAll(async () => {
  await stopTaskWorker();
  await stopBoss();
  await closePool();
});

describe("queue worker", () => {
  it("picks up a new task and completes it", async () => {
    h.setPlan([{ name: "mock.note", input: { text: "hello" } }]);
    const { taskId } = await createTask({ actorUserId: "owner", orgId: h.orgId, intent: "note it" });
    await waitFor(h.orgId, taskId, ["COMPLETED"]);
    expect(h.ledger.effects.size).toBe(1);
  });

  it("runs the delayed retry job after a dropped connection, with one effect", async () => {
    h.setPlan([{ name: "mock.note", input: { text: "once" } }]);
    h.ledger.failNext = { count: 1, retryable: true, afterEffect: true };
    const { taskId } = await createTask({ actorUserId: "owner", orgId: h.orgId, intent: "note it" });
    await waitFor(h.orgId, taskId, ["RETRY_SCHEDULED", "COMPLETED"]);
    const done = await waitFor(h.orgId, taskId, ["COMPLETED"]);
    expect(done.attempts).toBe(2);
    expect(h.ledger.effects.size).toBe(1);
  });

  it("resumes a task when its approval is granted", async () => {
    h.setPlan([{ name: "mock.send_email", input: { to: "c@example.test", subject: "s", body: "b" } }]);
    const { taskId } = await createTask({ actorUserId: "owner", orgId: h.orgId, intent: "email" });
    await waitFor(h.orgId, taskId, ["WAITING_FOR_APPROVAL"]);
    const [ap] = await approvalsFor(h.orgId, taskId);
    await decideApproval({ actorUserId: "admin", orgId: h.orgId, approvalId: ap!.id, decision: "approve" });
    await waitFor(h.orgId, taskId, ["COMPLETED"]);
    expect(h.ledger.effects.size).toBe(1);
  });
});

describe("queue maintenance", () => {
  it("retries a job held by a worker that died, running as the app role", async () => {
    const ownerBoss = new PgBoss({ connectionString: process.env.DATABASE_URL_OWNER, schema: "pgboss", supervise: false, schedule: false });
    await ownerBoss.start();
    await ownerBoss.createQueue("zz.crash", { expireInSeconds: 1, retryLimit: 2, retryDelay: 1 });
    await ownerBoss.stop({ graceful: false });
    const app = new PgBoss({ connectionString: process.env.DATABASE_URL, schema: "pgboss", migrate: false, createSchema: false, schedule: false, supervise: true, superviseIntervalSeconds: 1, maintenanceIntervalSeconds: 1, monitorIntervalSeconds: 1 } as never);
    await app.start();
    try {
      const id = await app.send("zz.crash", { probe: true });
      const [taken] = await app.fetch("zz.crash"); // taken by a worker that then "crashes"
      expect(taken?.id).toBe(id);
      let state = "active";
      for (let i = 0; i < 20 && state === "active"; i++) {
        await new Promise((r) => setTimeout(r, 500));
        state = (await app.getJobById("zz.crash", id!))?.state ?? "missing";
      }
      expect(state).toBe("retry");
    } finally {
      await app.stop({ graceful: false });
      const cleanup = new PgBoss({ connectionString: process.env.DATABASE_URL_OWNER, schema: "pgboss", supervise: false, schedule: false });
      await cleanup.start();
      await cleanup.deleteQueue("zz.crash");
      await cleanup.stop({ graceful: false });
    }
  }, 20_000);
});
