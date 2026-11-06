import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, contacts, crmRecords, invoices, tasks, withTenant } from "@wos/db";
import {
  AppError,
  approvalsForReview,
  CHAT_MESSAGES_PER_MINUTE,
  createTask,
  createThread,
  decideApproval,
  finishedWithoutActions,
  getEngine,
  getPauseState,
  getThread,
  inviteMember,
  mockLeadBotPlan,
  retryEscalatedTask,
  runTask,
  sendMessage,
  setAgentsPaused,
  stopBoss,
  taskLabel,
  transition,
} from "../src/index";
import { seedUser } from "../../db/test/helpers";
import { approvalsFor, auditActions, setupHarness, taskRow, type Harness } from "./engine-helpers";

// Session 5 review: honest outcomes, reviewable approvals, kill switch,
// chat rate limit, retry of escalated tasks.

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

async function task(intent = "Do the thing", actor = "member", extra: Partial<Parameters<typeof createTask>[0]> = {}) {
  return (await createTask({ actorUserId: actor, orgId: h.orgId, intent, ...extra })).taskId;
}

describe("honest outcomes (Law 2)", () => {
  it("a completed task with no planned actions is reported as such", async () => {
    h.setPlan([]);
    const id = await task();
    expect(await runTask(h.orgId, id)).toBe("COMPLETED");
    expect(finishedWithoutActions(await taskRow(h.orgId, id))).toBe(true);
    h.setPlan([{ name: "mock.note", input: { text: "x" } }]);
    const did = await task();
    expect(await runTask(h.orgId, did)).toBe("COMPLETED");
    expect(finishedWithoutActions(await taskRow(h.orgId, did))).toBe(false);
    expect(finishedWithoutActions({ state: "FAILED", plan: null })).toBe(false);
  });

  it("tasks carry a human title; the instruction for the agent is unchanged", async () => {
    const id = await task("Triage this email conversation: set a category with inbox.categorize ...", "member", { title: "  Triage email:\n  Invoice question " });
    const t = await taskRow(h.orgId, id);
    expect(t.title).toBe("Triage email: Invoice question");
    expect(t.intent).toMatch(/^Triage this email conversation/);
    expect(taskLabel(t)).toBe("Triage email: Invoice question");
    expect(taskLabel({ title: null, intent: "x".repeat(300) })).toHaveLength(138);
  });

  it("the MOCK lead bot hands off the person's words, not the prompt wrapper", () => {
    const r = mockLeadBotPlan({ purpose: "lead.plan", tenantId: "t", system: "", messages: [{ role: "user", content: "<external_data>old</external_data>\n\nRequest from the business user:\nChase overdue invoices" }] });
    expect(r.toolCalls).toEqual([{ name: "delegate", input: { agent: "finance", request: "Chase overdue invoices" } }]);
  });
});

describe("approvals a person can judge", () => {
  async function seedFinance() {
    return withTenant(h.orgId, async (tx) => {
      const [c] = await tx.insert(contacts).values({ tenantId: h.orgId, name: "Maya Chen", email: "maya@chenbakery.test", company: "Chen Bakery" }).returning();
      const [inv] = await tx
        .insert(invoices)
        .values({ tenantId: h.orgId, provider: "fake", externalId: "in_1", number: "RB-101", customerName: "Chen Bakery", customerEmail: "maya@chenbakery.test", status: "open", amountDueCents: 45000, dueDate: "2026-10-15" })
        .returning();
      const [deal] = await tx.insert(crmRecords).values({ tenantId: h.orgId, contactId: c!.id, provider: "fake", externalId: "d1", name: "Chen Bakery: payroll", stage: "qualifiedtobuy" }).returning();
      return { invoiceId: inv!.id, dealId: deal!.id };
    });
  }

  it("resolves ids in the action to customer, amount, due date and deal facts", async () => {
    const { invoiceId, dealId } = await seedFinance();
    h.setPlan([
      { name: "mock.charge", input: { customer: "cus_1", amountCents: 45000 } },
    ]);
    const id = await task("Charge it");
    await runTask(h.orgId, id);
    // Point the stored approval at real records (MOCK tools don't take invoice/deal ids).
    await withTenant(h.orgId, async (tx) => {
      const { approvalRequests } = await import("@wos/db");
      const [ap] = await tx.select().from(approvalRequests).where(eq(approvalRequests.taskId, id));
      await tx.update(approvalRequests).set({ payload: { ...ap!.payload, args: { invoiceId, dealId, amountCents: 57000 } } }).where(eq(approvalRequests.id, ap!.id));
    });
    const { open } = await approvalsForReview({ actorUserId: "owner", orgId: h.orgId });
    const ctx = Object.fromEntries(open[0]!.context.map((l) => [l.label, l.value]));
    expect(ctx.Customer).toBe("Chen Bakery · maya@chenbakery.test");
    expect(ctx.Invoice).toBe("RB-101 · $450.00 due");
    expect(ctx.Due).toMatch(/^2026-10-15 \(\d+ days overdue\)$/);
    expect(ctx.Deal).toBe("Chen Bakery: payroll");
    expect(ctx.Contact).toBe("Maya Chen · Chen Bakery · maya@chenbakery.test");
    expect(ctx["Change to"]).toBe("$570.00");
    expect(open[0]!.headline).toBe(open[0]!.approval.summary); // MOCK charge summary names no record ids
    expect(open[0]).toMatchObject({ taskTitle: "Charge it", requestedByName: "member", reviewer: { kind: "can_approve" } });
  });

  it("rewrites record ids in the card title to names", async () => {
    const { invoiceId, dealId } = await seedFinance();
    h.setPlan([{ name: "mock.charge", input: { customer: "c", amountCents: 1 } }, { name: "mock.charge", input: { customer: "d", amountCents: 2 } }]);
    const id = await task("Two");
    await runTask(h.orgId, id);
    await withTenant(h.orgId, async (tx) => {
      const { approvalRequests } = await import("@wos/db");
      const aps = await tx.select().from(approvalRequests).where(eq(approvalRequests.taskId, id)).orderBy(approvalRequests.summary);
      await tx.update(approvalRequests).set({ summary: `Send a payment reminder for invoice ${invoiceId.slice(0, 8)}`, payload: { ...aps[0]!.payload, args: { invoiceId } } }).where(eq(approvalRequests.id, aps[0]!.id));
      await tx.update(approvalRequests).set({ summary: `Set deal ${dealId.slice(0, 8)} amount to $570.00`, payload: { ...aps[1]!.payload, args: { dealId, amountCents: 57000 } } }).where(eq(approvalRequests.id, aps[1]!.id));
    });
    const { open } = await approvalsForReview({ actorUserId: "owner", orgId: h.orgId });
    expect(open.map((a) => a.headline).sort()).toEqual([
      "Send a payment reminder for invoice RB-101 (Chen Bakery, $450.00)",
      'Set the "Chen Bakery: payroll" deal amount to $570.00',
    ]);
  });

  it("another org's invoice id resolves to 'not found', never to its data", async () => {
    const other = await setupOtherOrgInvoice();
    h.setPlan([{ name: "mock.charge", input: { customer: "c", amountCents: 100 } }]);
    const id = await task("Charge");
    await runTask(h.orgId, id);
    await withTenant(h.orgId, async (tx) => {
      const { approvalRequests } = await import("@wos/db");
      const [ap] = await tx.select().from(approvalRequests).where(eq(approvalRequests.taskId, id));
      await tx.update(approvalRequests).set({ payload: { ...ap!.payload, args: { invoiceId: other } } }).where(eq(approvalRequests.id, ap!.id));
    });
    const { open } = await approvalsForReview({ actorUserId: "owner", orgId: h.orgId });
    expect(open[0]!.context).toEqual([{ label: "Invoice", value: "Not found in this organization's records" }]);
  });

  async function setupOtherOrgInvoice(): Promise<string> {
    const { createOrg } = await import("../src/index");
    const { orgId } = await createOrg({ actorUserId: "outsider", name: "Other" });
    return withTenant(orgId, async (tx) => {
      const [inv] = await tx.insert(invoices).values({ tenantId: orgId, provider: "fake", externalId: "secret", customerName: "SECRET CUSTOMER", status: "open", amountDueCents: 999 }).returning();
      return inv!.id;
    });
  }

  it("tells each viewer what they may do: requester, member, sole manager, and tier 4 confirmer", async () => {
    h.setPlan([{ name: "mock.send_email", input: { to: "a@example.test", subject: "s", body: "b" } }]);
    const mine = await task("Email", "owner");
    await runTask(h.orgId, mine);
    let { open } = await approvalsForReview({ actorUserId: "owner", orgId: h.orgId });
    expect(open[0]!.reviewer).toEqual({ kind: "read_only", reason: "You asked for this work, so another owner or admin has to approve it." });
    ({ open } = await approvalsForReview({ actorUserId: "admin", orgId: h.orgId }));
    expect(open[0]!.reviewer).toEqual({ kind: "can_approve" });
    ({ open } = await approvalsForReview({ actorUserId: "member", orgId: h.orgId }));
    expect(open[0]!.reviewer.kind).toBe("read_only");

    // Tier 4: approved by the owner, so the owner can't confirm; no other owner exists.
    h.setPlan([{ name: "mock.delete_contact", input: { contactId: "c1" } }]);
    const del = await task("Delete", "member");
    await runTask(h.orgId, del);
    const before = (await approvalsForReview({ actorUserId: "owner", orgId: h.orgId })).open.find((a) => a.taskId === del)!;
    expect(before.reviewer).toMatchObject({ kind: "can_approve", note: expect.stringContaining("there isn't one yet") });
    const [ap] = await approvalsFor(h.orgId, del);
    await decideApproval({ actorUserId: "owner", orgId: h.orgId, approvalId: ap!.id, decision: "approve" });
    const after = (await approvalsForReview({ actorUserId: "owner", orgId: h.orgId })).open.find((a) => a.taskId === del)!;
    expect(after.reviewer).toEqual({ kind: "read_only", reason: expect.stringContaining("no other owner") });

    // Add a second owner: they can confirm.
    await seedUser("owner2", "owner2@example.test");
    await inviteMember({ actorUserId: "owner", orgId: h.orgId, email: "owner2@example.test", role: "owner" });
    const second = (await approvalsForReview({ actorUserId: "owner2", orgId: h.orgId })).open.find((a) => a.taskId === del)!;
    expect(second.reviewer).toEqual({ kind: "can_confirm" });
    expect(second.decidedByName).toBe("owner");
  });

  it("counts other open approvals in the same task", async () => {
    h.setPlan([
      { name: "mock.send_email", input: { to: "a@example.test", subject: "1", body: "b" } },
      { name: "mock.send_email", input: { to: "b@example.test", subject: "2", body: "b" } },
    ]);
    const id = await task("Two emails");
    await runTask(h.orgId, id);
    const { open } = await approvalsForReview({ actorUserId: "owner", orgId: h.orgId });
    expect(open.map((a) => a.otherOpenInTask)).toEqual([1, 1]);
  });

  it("marks chat hand-offs and fields copied from external text", async () => {
    const { threadId } = await createThread({ actorUserId: "owner", orgId: h.orgId, title: "Week" });
    const r = await sendMessage({ actorUserId: "owner", orgId: h.orgId, threadId, content: "Reply to the email from x@client.test" });
    h.setPlan([{ name: "mock.note", input: { text: "contact x@client.test" } }]);
    await runTask(h.orgId, r.taskIds[0]!);
    const { open } = await approvalsForReview({ actorUserId: "admin", orgId: h.orgId });
    expect(open[0]).toMatchObject({ fromChat: { threadId, title: "Week" }, externalDataFields: ["text"] });
  });

  it("is invisible to other orgs", async () => {
    await expectCode(approvalsForReview({ actorUserId: "outsider", orgId: h.orgId }), "NOT_FOUND");
  });
});

describe("kill switch", () => {
  it("only owners pause; while paused no task advances; resuming re-queues and work continues", async () => {
    await expectCode(setAgentsPaused({ actorUserId: "admin", orgId: h.orgId, paused: true }), "FORBIDDEN");
    await setAgentsPaused({ actorUserId: "owner", orgId: h.orgId, paused: true });
    expect(await getPauseState({ actorUserId: "viewer", orgId: h.orgId })).toMatchObject({ paused: true, pausedByName: "owner" });
    await expectCode(setAgentsPaused({ actorUserId: "owner", orgId: h.orgId, paused: true }), "CONFLICT");

    h.setPlan([{ name: "mock.note", input: { text: "x" } }]);
    const id = await task();
    expect(await runTask(h.orgId, id)).toBe("REQUESTED");
    expect(h.ledger.calls).toBe(0);
    expect(h.model.calls).toHaveLength(0); // not even a model call

    const res = await setAgentsPaused({ actorUserId: "owner", orgId: h.orgId, paused: false });
    expect(res.resumedTasks).toBeGreaterThanOrEqual(1);
    expect(await runTask(h.orgId, id)).toBe("COMPLETED");
    const actions = (await auditActions(h.orgId)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["agents.pause", "agents.resume"]));
  });

  it("stops between actions when paused mid-plan, and finished actions aren't repeated", async () => {
    h.setPlan([{ name: "mock.note", input: { text: "1" } }, { name: "mock.note", input: { text: "2" } }]);
    const id = await task();
    // The owner hits pause while the first action is running.
    const tool = getEngine().tools.get("mock.note")!;
    const run = tool.execute.bind(tool);
    tool.execute = async (ctx, a) => {
      const r = await run(ctx, a);
      if ((a as { text: string }).text === "1") await setAgentsPaused({ actorUserId: "owner", orgId: h.orgId, paused: true });
      return r;
    };
    expect(await runTask(h.orgId, id)).toBe("EXECUTING");
    expect(h.ledger.effects.size).toBe(1);
    await setAgentsPaused({ actorUserId: "owner", orgId: h.orgId, paused: false });
    expect(await runTask(h.orgId, id)).toBe("COMPLETED");
    expect(h.ledger.effects.size).toBe(2);
    expect(h.ledger.calls).toBe(2);
  });

  it("the lead bot hands nothing off and says why", async () => {
    await setAgentsPaused({ actorUserId: "owner", orgId: h.orgId, paused: true });
    const { threadId } = await createThread({ actorUserId: "owner", orgId: h.orgId, title: "t" });
    const r = await sendMessage({ actorUserId: "owner", orgId: h.orgId, threadId, content: "Send reminders for overdue invoices" });
    expect(r.taskIds).toEqual([]);
    const view = await getThread({ actorUserId: "owner", orgId: h.orgId, threadId });
    expect(view.messages.at(-1)!.content).toMatch(/^Agents are paused/);
    expect(h.model.calls).toHaveLength(0);
  });
});

describe("chat", () => {
  it("names who wrote each message", async () => {
    const { threadId } = await createThread({ actorUserId: "owner", orgId: h.orgId, title: "t" });
    await sendMessage({ actorUserId: "member", orgId: h.orgId, threadId, content: "hello" });
    const view = await getThread({ actorUserId: "owner", orgId: h.orgId, threadId });
    expect(view.messages.map((m) => m.authorName)).toEqual(["member", "Lead bot"]);
  });

  it(`limits each person to ${CHAT_MESSAGES_PER_MINUTE} messages a minute, audited; a retried message isn't counted twice`, async () => {
    const { threadId } = await createThread({ actorUserId: "owner", orgId: h.orgId, title: "t" });
    for (let i = 0; i < CHAT_MESSAGES_PER_MINUTE; i++) await sendMessage({ actorUserId: "owner", orgId: h.orgId, threadId, content: `hi ${i}`, clientRef: `ref-${i}` });
    // A double-submit of an earlier message still resolves to that message.
    expect(await sendMessage({ actorUserId: "owner", orgId: h.orgId, threadId, content: "hi 0", clientRef: "ref-0" })).toMatchObject({ duplicate: true });
    await expectCode(sendMessage({ actorUserId: "owner", orgId: h.orgId, threadId, content: "one more" }), "RATE_LIMITED");
    // Other people aren't affected.
    await expect(sendMessage({ actorUserId: "member", orgId: h.orgId, threadId, content: "me too" })).resolves.toMatchObject({ duplicate: false });
    expect((await auditActions(h.orgId)).filter((a) => a.action === "chat.message.send" && a.outcome === "denied")).toHaveLength(1);
  });
});

describe("retry escalated tasks", () => {
  it("managers can retry after the retry limit; finished steps aren't repeated", async () => {
    h.setPlan([{ name: "mock.note", input: { text: "1" } }, { name: "mock.lookup", input: { q: "2" } }]);
    const original = h.ledger.record.bind(h.ledger);
    let down = true;
    h.ledger.record = (key, tool, args) => {
      if (tool === "mock.lookup" && down) {
        h.ledger.calls++;
        throw Object.assign(new Error("MOCK provider down"), { retryable: true });
      }
      return original(key, tool, args);
    };
    const id = await task();
    let state = await runTask(h.orgId, id);
    while (state === "RETRY_SCHEDULED") state = await runTask(h.orgId, id, { retry: true });
    expect(state).toBe("ESCALATED");

    await expectCode(retryEscalatedTask({ actorUserId: "member", orgId: h.orgId, taskId: id }), "FORBIDDEN");
    down = false;
    expect(await retryEscalatedTask({ actorUserId: "admin", orgId: h.orgId, taskId: id })).toEqual({ state: "ASSIGNED" });
    expect(await runTask(h.orgId, id)).toBe("COMPLETED");
    expect([...h.ledger.effects.values()].filter((e) => e.tool === "mock.note")).toHaveLength(1);
    expect((await auditActions(h.orgId)).some((a) => a.action === "task.retry")).toBe(true);
  });

  it("refuses tasks that aren't escalated or never had a plan; other orgs get NOT_FOUND", async () => {
    h.setPlan([]);
    const done = await task();
    await runTask(h.orgId, done);
    await expectCode(retryEscalatedTask({ actorUserId: "owner", orgId: h.orgId, taskId: done }), "CONFLICT");
    const noPlan = await task();
    await withTenant(h.orgId, async (tx) => {
      const [t] = await tx.select().from(tasks).where(eq(tasks.id, noPlan));
      const c = await transition(tx, t!, "CLASSIFIED");
      await transition(tx, c, "ESCALATED", { error: { message: "x", code: "NO_AGENT" } });
    });
    await expectCode(retryEscalatedTask({ actorUserId: "owner", orgId: h.orgId, taskId: noPlan }), "CONFLICT");
    await expectCode(retryEscalatedTask({ actorUserId: "outsider", orgId: h.orgId, taskId: noPlan }), "NOT_FOUND");
  });
});
