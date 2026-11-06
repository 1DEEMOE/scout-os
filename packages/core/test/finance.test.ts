import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@wos/db";
import {
  AppError,
  chaseOverdue,
  configureEngine,
  connectStripe,
  createAgent,
  createOrg,
  createTask,
  decideApproval,
  evaluatePolicy,
  FakeInvoicingProvider,
  financeTools,
  findOverdue,
  inviteMember,
  listInvoices,
  partitionInvoices,
  MockModelProvider,
  ModelRouter,
  runTask,
  StripeInvoicingProvider,
  stopBoss,
  syncInvoices,
  ToolRegistry,
  type ModelResponse,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";
import { approvalsFor, taskRow } from "./engine-helpers";

let orgId: string;
let billing: FakeInvoicingProvider;
let plan: Partial<ModelResponse>;

async function expectCode(p: Promise<unknown>, code: AppError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
}

beforeEach(async () => {
  await resetDb();
  for (const u of ["owner", "admin", "member", "outsider"]) await seedUser(u, `${u}@example.test`);
  billing = new FakeInvoicingProvider();
  plan = { toolCalls: [] };
  configureEngine({
    router: new ModelRouter([new MockModelProvider((r) => (r.purpose === "classify" ? { text: "finance" } : plan))], "mock"),
    tools: new ToolRegistry().register(...financeTools(async () => billing)),
    invoicing: async () => billing,
  });
  orgId = (await createOrg({ actorUserId: "owner", name: "Books Co" })).orgId;
  await inviteMember({ actorUserId: "owner", orgId, email: "admin@example.test", role: "admin" });
  await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
  await createAgent({
    actorUserId: "owner",
    orgId,
    spec: { kind: "finance", displayName: "Finance", instructions: "Chase payments.", tools: [
      { name: "finance.send_invoice_reminder", maxTier: 2 }, { name: "finance.create_invoice", maxTier: 3 }, { name: "finance.void_invoice", maxTier: 3 }] },
  });
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

function seedProviderInvoices() {
  const add = (id: string, email: string, cents: number, due: string, status: "open" | "paid" = "open") =>
    billing.invoices.set(id, { externalId: id, customerEmail: email, status, amountDueCents: cents, currency: "usd", dueDate: due });
  add("in_1", "late@customer.test", 120000, "2026-10-01");
  add("in_2", "later@customer.test", 45050, "2026-10-20");
  add("in_3", "ontime@customer.test", 9900, "2026-12-01");
  add("in_4", "paid@customer.test", 5000, "2026-09-01", "paid");
}

describe("overdue invoices", () => {
  it("syncs, finds open invoices past due, and proposes reminders that each need approval", async () => {
    seedProviderInvoices();
    expect(await syncInvoices({ actorUserId: "member", orgId })).toEqual({ synced: 4, mock: true });
    const overdue = await findOverdue({ actorUserId: "member", orgId, today: "2026-11-03" });
    expect(overdue.map((i) => i.customerEmail)).toEqual(["late@customer.test", "later@customer.test"]);

    plan = { toolCalls: overdue.map((i) => ({ name: "finance.send_invoice_reminder", input: { invoiceId: i.id } })) };
    const { taskId } = await chaseOverdue({ actorUserId: "member", orgId, today: "2026-11-03" });
    expect(await runTask(orgId, taskId!)).toBe("WAITING_FOR_APPROVAL");
    const aps = await approvalsFor(orgId, taskId!);
    expect(aps.map((a) => a.tier)).toEqual([2, 2]);
    expect(billing.reminders).toHaveLength(0);

    for (const ap of aps) await decideApproval({ actorUserId: "admin", orgId, approvalId: ap.id, decision: "approve" });
    expect(await runTask(orgId, taskId!)).toBe("COMPLETED");
    expect(billing.reminders.map((r) => r.externalId).sort()).toEqual(["in_1", "in_2"]);
    const after = await listInvoices({ actorUserId: "member", orgId });
    expect(after.filter((i) => i.lastReminderAt).map((i) => i.externalId).sort()).toEqual(["in_1", "in_2"]);
  });

  it("returns no task when nothing is overdue", async () => {
    expect(await chaseOverdue({ actorUserId: "member", orgId, today: "2026-11-03" })).toEqual({ taskId: null, overdue: 0 });
  });
});

describe("creating and voiding invoices (tier 3)", () => {
  it("always waits for a human, stores cents exactly, and is idempotent", async () => {
    plan = {
      toolCalls: [{ name: "finance.create_invoice", input: { customerEmail: "Client@Customer.test", lines: [{ description: "October bookkeeping", amountCents: 45050 }, { description: "Payroll add-on", amountCents: 1999 }], daysUntilDue: 15 } }],
    };
    const { taskId } = await createTask({ actorUserId: "member", orgId, intent: "Bill the client" });
    expect(await runTask(orgId, taskId)).toBe("WAITING_FOR_APPROVAL");
    const [ap] = await approvalsFor(orgId, taskId);
    expect(ap).toMatchObject({ tier: 3, summary: "Invoice client@customer.test for $470.49 (2 lines, due in 15 days)" });
    await expectCode(decideApproval({ actorUserId: "member", orgId, approvalId: ap!.id, decision: "approve" }), "FORBIDDEN");
    await decideApproval({ actorUserId: "owner", orgId, approvalId: ap!.id, decision: "approve" });
    expect(await runTask(orgId, taskId)).toBe("COMPLETED");
    const [inv] = await listInvoices({ actorUserId: "member", orgId });
    expect(inv).toMatchObject({ amountDueCents: 47049, customerEmail: "client@customer.test", status: "open" });
    // The provider saw one creation for this step's key; a replay with the same key changes nothing.
    await billing.createInvoice({ customerEmail: "x@y.test", lines: [{ description: "x", amountCents: 1 }], currency: "usd", daysUntilDue: 1 }, [...(billing as unknown as { byKey: Map<string, unknown> }).byKey.keys()][0]!);
    expect(billing.invoices.size).toBe(1);
  });

  it("rejects fractional cents and totals over the limit before anything is planned", async () => {
    plan = { toolCalls: [{ name: "finance.create_invoice", input: { customerEmail: "c@x.test", lines: [{ description: "x", amountCents: 10.5 }] } }] };
    const a = (await createTask({ actorUserId: "member", orgId, intent: "x" })).taskId;
    expect(await runTask(orgId, a)).toBe("FAILED");
    plan = { toolCalls: [{ name: "finance.create_invoice", input: { customerEmail: "c@x.test", lines: [{ description: "x", amountCents: 60_000_000 }, { description: "y", amountCents: 60_000_000 }] } }] };
    const b = (await createTask({ actorUserId: "member", orgId, intent: "x" })).taskId;
    expect(await runTask(orgId, b)).toBe("FAILED");
    expect((await taskRow(orgId, b)).error).toMatchObject({ code: "INVALID_ACTION" });
  });

  it("tier 3 has no auto-approve path in the policy", () => {
    const tool = financeTools(async () => billing).find((t) => t.name === "finance.create_invoice")!;
    const d = evaluatePolicy(tool, tool.name, { allowlist: [tool.name], maxTier: new Map([[tool.name, 4]]) });
    expect(d.kind).toBe("needs_approval");
  });
});

describe("connection and isolation", () => {
  it("only the owner connects Stripe; keys are validated and encrypted", async () => {
    await expectCode(connectStripe({ actorUserId: "admin", orgId, secretKey: "sk_test_abc123" }), "FORBIDDEN");
    await expect(connectStripe({ actorUserId: "owner", orgId, secretKey: "pk_test_abc" })).rejects.toThrow(/Stripe secret/);
    expect(await connectStripe({ actorUserId: "owner", orgId, secretKey: "sk_test_abc123" })).toMatchObject({ live: false });
    const raw = await withTenant(orgId, (tx) => tx.execute(sql`SELECT row_to_json(c)::text AS j FROM integration_connections c`));
    expect((raw.rows[0] as { j: string }).j).not.toContain("sk_test_abc123");
  });

  it("another org can't see invoices", async () => {
    await expectCode(listInvoices({ actorUserId: "outsider", orgId }), "NOT_FOUND");
    await expectCode(findOverdue({ actorUserId: "outsider", orgId }), "NOT_FOUND");
  });
});

describe("Stripe adapter request shape (no network)", () => {
  it("passes idempotency keys on every write and builds the invoice in cents", async () => {
    const calls: { op: string; params: unknown; opts?: unknown }[] = [];
    const rec = (op: string, ret: unknown) => async (a: unknown, b?: unknown, c?: unknown) => {
      // Methods with an id take (id, params, opts); others take (params, opts).
      if (typeof a === "string") calls.push({ op, params: { id: a, ...(b as object) }, opts: c });
      else calls.push({ op, params: a, opts: b });
      return ret;
    };
    const inv = { id: "in_9", status: "open", amount_due: 47049, currency: "usd", customer_email: "c@x.test", number: "A-1", due_date: 1_790_000_000 };
    const client = {
      customers: { list: rec("customers.list", { data: [] }), create: rec("customers.create", { id: "cus_1" }) },
      invoices: { create: rec("invoices.create", { id: "in_9" }), finalizeInvoice: rec("invoices.finalize", inv), sendInvoice: rec("invoices.send", inv), voidInvoice: rec("invoices.void", { ...inv, status: "void" }) },
      invoiceItems: { create: rec("invoiceItems.create", {}) },
    };
    const s = new StripeInvoicingProvider("sk_test_x", client as never);
    const out = await s.createInvoice({ customerEmail: "c@x.test", lines: [{ description: "A", amountCents: 45050 }, { description: "B", amountCents: 1999 }], currency: "usd", daysUntilDue: 15 }, "k1");
    expect(out).toMatchObject({ externalId: "in_9", amountDueCents: 47049, status: "open" });
    const writes = calls.filter((c) => c.op !== "customers.list");
    expect(writes.map((c) => (c.opts as { idempotencyKey: string }).idempotencyKey)).toEqual(["k1:customer", "k1:invoice", "k1:line:0", "k1:line:1", "k1:finalize"]);
    expect(calls.find((c) => c.op === "invoices.create")!.params).toMatchObject({ collection_method: "send_invoice", days_until_due: 15, auto_advance: false });
    expect(calls.filter((c) => c.op === "invoiceItems.create").map((c) => (c.params as { amount: number }).amount)).toEqual([45050, 1999]);
  });
});

describe("partitionInvoices", () => {
  it("keeps paid invoices out of the overdue list", () => {
    const today = "2026-11-05";
    const rows = [
      { status: "open", dueDate: "2026-10-12", id: "a" },
      { status: "open", dueDate: "2026-11-20", id: "b" },
      { status: "paid", dueDate: "2026-10-01", id: "c" },
      { status: "open", dueDate: null, id: "d" },
    ];
    const { overdue, other } = partitionInvoices(rows, today);
    expect(overdue.map((i) => i.id)).toEqual(["a"]);
    expect(other.map((i) => i.id)).toEqual(["b", "c", "d"]);
  });
});
