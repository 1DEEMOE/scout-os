import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import { AppError, cancelTask, createTask, decideApproval, runTask, stopBoss, TASK_CREATE_LIMIT_PER_HOUR } from "../src/index";
import { ownerQuery } from "../../db/test/helpers";
import { approvalsFor, setupHarness, taskRow, type Harness } from "./engine-helpers";

let h: Harness;

beforeEach(async () => {
  h = await setupHarness();
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

async function expectCode(p: Promise<unknown>, code: AppError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
}

/** A task that stops at WAITING_FOR_APPROVAL because its step is tier 2. */
async function waitingTask() {
  h.setPlan([{ name: "mock.send_email", input: { to: "customer@example.test", subject: "Hi", body: "x" } }]);
  const { taskId } = await createTask({ actorUserId: "owner", orgId: h.orgId, intent: "Email the customer" });
  expect(await runTask(h.orgId, taskId)).toBe("WAITING_FOR_APPROVAL");
  return taskId;
}

describe("cancelTask", () => {
  it("the requester cancels a task waiting for approval; its approvals lapse", async () => {
    const taskId = await waitingTask();
    const r = await cancelTask({ actorUserId: "owner", orgId: h.orgId, taskId });
    expect(r.state).toBe("FAILED");
    const t = await taskRow(h.orgId, taskId);
    expect(t.error).toMatchObject({ code: "CANCELLED" });
    expect((await approvalsFor(h.orgId, taskId)).map((a) => a.status)).toEqual(["expired"]);

    // A queued wake-up notices the terminal state and does nothing.
    expect(await runTask(h.orgId, taskId)).toBe("FAILED");
  });

  it("a manager can cancel another member's task; a plain member cannot", async () => {
    h.setPlan([{ name: "mock.note", input: { text: "hi" } }]);
    const { taskId } = await createTask({ actorUserId: "member", orgId: h.orgId, intent: "note" });
    await expectCode(cancelTask({ actorUserId: "viewer", orgId: h.orgId, taskId }), "FORBIDDEN");
    expect((await cancelTask({ actorUserId: "admin", orgId: h.orgId, taskId })).state).toBe("FAILED");
  });

  it("refuses to cancel a finished task", async () => {
    h.setPlan([]);
    const { taskId } = await createTask({ actorUserId: "owner", orgId: h.orgId, intent: "nothing to do" });
    expect(await runTask(h.orgId, taskId)).toBe("COMPLETED");
    await expectCode(cancelTask({ actorUserId: "owner", orgId: h.orgId, taskId }), "CONFLICT");
  });

  it("hides other orgs' tasks and non-members entirely", async () => {
    const taskId = await waitingTask();
    await expectCode(cancelTask({ actorUserId: "outsider", orgId: h.orgId, taskId }), "NOT_FOUND");
    await expectCode(cancelTask({ actorUserId: "owner", orgId: h.orgId, taskId: "00000000-0000-4000-8000-000000000000" }), "NOT_FOUND");
  });
});

describe("task.create rate limit", () => {
  it(`refuses task ${TASK_CREATE_LIMIT_PER_HOUR + 1} within the hour for the same user`, async () => {
    for (let i = 0; i < TASK_CREATE_LIMIT_PER_HOUR; i++) {
      await createTask({ actorUserId: "member", orgId: h.orgId, intent: `task ${i}` });
    }
    await expectCode(createTask({ actorUserId: "member", orgId: h.orgId, intent: "one too many" }), "RATE_LIMITED");
    // Another user in the same org is unaffected.
    await createTask({ actorUserId: "owner", orgId: h.orgId, intent: "still fine" });
  }, 30000);
});

describe("approval expiry wake-up", () => {
  it("enqueues a delayed run so an unanswered approval fails the task without a UI visit", async () => {
    const taskId = await waitingTask();
    const jobs = await ownerQuery<{ start_after: Date; data: { taskId: string } }>(
      "SELECT start_after, data FROM pgboss.job WHERE name = 'task.run' AND state = 'created'",
    );
    const wake = jobs.filter((j) => j.data.taskId === taskId && j.start_after.getTime() > Date.now() + 30_000);
    expect(wake.length).toBe(1);
  });

  it("a task whose approval expired fails with APPROVAL_EXPIRED when re-run", async () => {
    h.setPlan([{ name: "mock.send_email", input: { to: "customer@example.test", subject: "Hi", body: "x" } }]);
    const { taskId } = await createTask({ actorUserId: "owner", orgId: h.orgId, intent: "Email the customer" });
    expect(await runTask(h.orgId, taskId)).toBe("WAITING_FOR_APPROVAL");
    // Force expiry and let the wake-up path (a plain re-run) notice it.
    await ownerQuery("ALTER TABLE approval_requests DISABLE ROW LEVEL SECURITY");
    try {
      await ownerQuery("UPDATE approval_requests SET requested_at = requested_at - interval '2 hours', expires_at = now() - interval '1 hour'");
    } finally {
      await ownerQuery("ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY");
    }
    expect(await runTask(h.orgId, taskId)).toBe("FAILED");
    const t = await taskRow(h.orgId, taskId);
    expect(t.error).toMatchObject({ code: "APPROVAL_EXPIRED" });
    // Deciding on the expired approval is refused.
    const ap = (await approvalsFor(h.orgId, taskId))[0]!;
    await expectCode(decideApproval({ actorUserId: "owner", orgId: h.orgId, approvalId: ap.id, decision: "approve" }), "CONFLICT");
  });
});
