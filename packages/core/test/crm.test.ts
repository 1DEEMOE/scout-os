import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, emailIdentities, withTenant } from "@wos/db";
import {
  AppError,
  configureEngine,
  connectGoogleMailbox,
  connectHubSpot,
  createAgent,
  createOrg,
  createTask,
  crmTools,
  decideApproval,
  FakeCrmProvider,
  FakeMailProvider,
  HubSpotProvider,
  inboxTools,
  inviteMember,
  listContacts,
  listDeals,
  MockModelProvider,
  ModelRouter,
  qualifyLead,
  runTask,
  stopBoss,
  syncInbox,
  ToolRegistry,
  type MailboxResolver,
  type ModelResponse,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";
import { approvalsFor, taskRow } from "./engine-helpers";

let orgId: string;
let crm: FakeCrmProvider;
let mail: FakeMailProvider;
let plan: Partial<ModelResponse>;

const mailbox: MailboxResolver = async (t) => {
  const [identity] = await withTenant(t, (tx) => tx.select().from(emailIdentities));
  return identity ? { provider: mail, identity } : null;
};

async function expectCode(p: Promise<unknown>, code: AppError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
}

async function salesAgent(tools: { name: string; maxTier: number }[]) {
  await createAgent({ actorUserId: "owner", orgId, spec: { kind: "sales", displayName: "Sales", instructions: "Work leads.", tools } });
}

const fullSales = [
  { name: "crm.upsert_contact", maxTier: 1 },
  { name: "crm.create_deal", maxTier: 1 },
  { name: "crm.add_note", maxTier: 1 },
  { name: "crm.update_deal_stage", maxTier: 2 },
  { name: "crm.set_deal_amount", maxTier: 3 },
  { name: "inbox.create_draft", maxTier: 1 },
];

beforeEach(async () => {
  await resetDb();
  for (const u of ["owner", "member", "outsider"]) await seedUser(u, `${u}@example.test`);
  crm = new FakeCrmProvider();
  mail = new FakeMailProvider();
  plan = { toolCalls: [] };
  configureEngine({
    router: new ModelRouter([new MockModelProvider((r) => (r.purpose === "classify" ? { text: "sales" } : plan))], "mock"),
    tools: new ToolRegistry().register(...crmTools(async () => crm), ...inboxTools(mailbox)),
    mailbox,
    crm: async () => crm,
    retryBaseSeconds: 1,
  });
  orgId = (await createOrg({ actorUserId: "owner", name: "Sales Co" })).orgId;
  await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

async function dealTask() {
  plan = {
    toolCalls: [
      { name: "crm.upsert_contact", input: { email: "Lead@Prospect.test", name: "Lena Lead", company: "Prospect LLC" } },
      { name: "crm.create_deal", input: { name: "Prospect LLC bookkeeping", contactEmail: "lead@prospect.test" } },
    ],
  };
  const { taskId } = await createTask({ actorUserId: "member", orgId, intent: "Add this lead" });
  return taskId;
}

describe("lead from the inbox", () => {
  it("saves the contact, opens a deal, notes it and drafts a follow-up; steps using the sender's address wait for a human (G7)", async () => {
    await salesAgent(fullSales);
    await connectGoogleMailbox({ actorUserId: "owner", orgId, address: "office@acme.test", tokens: { refresh_token: "r" }, scopes: [] });
    mail.inbox.push({ externalId: "m1", threadId: "t1", from: "Lena Lead <lead@prospect.test>", to: ["office@acme.test"], subject: "Need a bookkeeper", body: "Can you quote monthly bookkeeping?", sentAt: new Date(), direction: "inbound" });
    await syncInbox({ actorUserId: "member", orgId });
    const [conv] = await withTenant(orgId, (tx) => tx.execute(sql`SELECT id FROM conversations`)).then((r) => r.rows as { id: string }[]);
    plan = {
      toolCalls: [
        { name: "crm.upsert_contact", input: { email: "lead@prospect.test", name: "Lena Lead" } },
        { name: "crm.create_deal", input: { name: "Monthly bookkeeping", contactEmail: "lead@prospect.test" } },
        { name: "crm.add_note", input: { contactEmail: "lead@prospect.test", body: "Asked for a bookkeeping quote." } },
        { name: "inbox.create_draft", input: { conversationId: conv!.id, body: "Thanks Lena, here's how we work..." } },
      ],
    };
    const { taskId } = await qualifyLead({ actorUserId: "member", orgId, conversationId: conv!.id });
    // The sender's address came from the email, so every step that uses it is raised to tier 2.
    expect(await runTask(orgId, taskId)).toBe("WAITING_FOR_APPROVAL");
    const aps = await approvalsFor(orgId, taskId);
    expect(aps.map((a) => [a.toolName, a.tier]).sort()).toEqual([["crm.add_note", 2], ["crm.create_deal", 2], ["crm.upsert_contact", 2]]);
    expect(aps.every((a) => Array.isArray((a.payload as { externalDataFields?: unknown }).externalDataFields))).toBe(true);
    expect(crm.notes.size).toBe(0);
    for (const a of aps) await decideApproval({ actorUserId: "owner", orgId, approvalId: a.id, decision: "approve" });
    expect(await runTask(orgId, taskId)).toBe("COMPLETED");
    const deals = await listDeals({ actorUserId: "member", orgId });
    expect(deals).toEqual([expect.objectContaining({ contactEmail: "lead@prospect.test", deal: expect.objectContaining({ name: "Monthly bookkeeping", stage: "appointmentscheduled", provider: "fake" }) })]);
    expect(crm.notes.size).toBe(1);
    expect([...mail.drafts.values()][0]!.to).toEqual(["lead@prospect.test"]);
    expect(mail.sendCalls).toBe(0);
  });
});

describe("idempotency", () => {
  it("a deal creation interrupted mid-call is found on retry, not duplicated", async () => {
    await salesAgent(fullSales);
    const original = crm.createDeal.bind(crm);
    let dropped = false;
    crm.createDeal = async (d, key) => {
      const r = await original(d, key);
      if (!dropped) {
        dropped = true;
        throw new Error("MOCK connection reset");
      }
      return r;
    };
    const taskId = await dealTask();
    expect(await runTask(orgId, taskId)).toBe("RETRY_SCHEDULED");
    expect(await runTask(orgId, taskId, { retry: true })).toBe("COMPLETED");
    expect(crm.deals.size).toBe(1);
    expect(await listDeals({ actorUserId: "member", orgId })).toHaveLength(1);
    expect(await listContacts({ actorUserId: "member", orgId })).toHaveLength(1);
  });
});

describe("field-level risk", () => {
  async function openDeal() {
    const taskId = await dealTask();
    expect(await runTask(orgId, taskId)).toBe("COMPLETED");
    return (await listDeals({ actorUserId: "member", orgId }))[0]!.deal.id;
  }

  it("changing an amount is tier 3: an agent capped at tier 2 is blocked outright", async () => {
    await salesAgent(fullSales.map((t) => (t.name === "crm.set_deal_amount" ? { ...t, maxTier: 2 } : t)));
    const dealId = await openDeal();
    plan = { toolCalls: [{ name: "crm.set_deal_amount", input: { dealId, amountCents: 250000 } }] };
    const { taskId } = await createTask({ actorUserId: "member", orgId, intent: "Price it" });
    expect(await runTask(orgId, taskId)).toBe("FAILED");
    expect((await taskRow(orgId, taskId)).error).toMatchObject({ code: "POLICY_DENIED" });
  });

  it("with tier 3 allowed it still waits for a human, then sets the amount", async () => {
    await salesAgent(fullSales);
    const dealId = await openDeal();
    plan = { toolCalls: [{ name: "crm.set_deal_amount", input: { dealId, amountCents: 250000 } }] };
    const { taskId } = await createTask({ actorUserId: "member", orgId, intent: "Price it" });
    expect(await runTask(orgId, taskId)).toBe("WAITING_FOR_APPROVAL");
    const [ap] = await approvalsFor(orgId, taskId);
    expect(ap).toMatchObject({ tier: 3, summary: expect.stringContaining("$2,500.00") });
    await decideApproval({ actorUserId: "owner", orgId, approvalId: ap!.id, decision: "approve" });
    expect(await runTask(orgId, taskId)).toBe("COMPLETED");
    expect([...crm.deals.values()][0]!.amountCents).toBe(250000);
  });

  it("a stage change is tier 2", async () => {
    await salesAgent(fullSales);
    const dealId = await openDeal();
    plan = { toolCalls: [{ name: "crm.update_deal_stage", input: { dealId, stage: "contractsent" } }] };
    const { taskId } = await createTask({ actorUserId: "member", orgId, intent: "Advance it" });
    expect(await runTask(orgId, taskId)).toBe("WAITING_FOR_APPROVAL");
    expect((await approvalsFor(orgId, taskId))[0]!.tier).toBe(2);
  });
});

describe("connection and isolation", () => {
  it("only managers connect HubSpot; the token is encrypted", async () => {
    await expectCode(connectHubSpot({ actorUserId: "member", orgId, accessToken: "pat-na1-abcdef123456", label: "portal" }), "FORBIDDEN");
    await connectHubSpot({ actorUserId: "owner", orgId, accessToken: "pat-na1-abcdef123456", label: "portal" });
    const raw = await withTenant(orgId, (tx) => tx.execute(sql`SELECT row_to_json(c)::text AS j FROM integration_connections c`));
    expect((raw.rows[0] as { j: string }).j).not.toContain("pat-na1-abcdef123456");
  });

  it("another org can't list contacts or deals", async () => {
    await expectCode(listContacts({ actorUserId: "outsider", orgId }), "NOT_FOUND");
    await expectCode(listDeals({ actorUserId: "outsider", orgId }), "NOT_FOUND");
  });
});

describe("HubSpot adapter request shape (no network)", () => {
  it("searches before creating and tags deals with the idempotency key", async () => {
    const calls: { op: string; arg: unknown }[] = [];
    const api = (obj: string) => ({
      searchApi: { doSearch: async (arg: unknown) => { calls.push({ op: `${obj}.search`, arg }); return { results: [] }; } },
      basicApi: {
        create: async (arg: unknown) => { calls.push({ op: `${obj}.create`, arg }); return { id: `${obj}-1` }; },
        update: async (id: string, arg: unknown) => { calls.push({ op: `${obj}.update`, arg: { id, arg } }); return { id }; },
      },
    });
    const hs = new HubSpotProvider("token", { crm: { contacts: api("contacts"), deals: api("deals"), objects: { notes: api("notes") } } } as never);
    expect(await hs.upsertContact({ email: "A@B.test", name: "Ann Lee" })).toEqual({ externalId: "contacts-1" });
    expect(calls[1]).toEqual({ op: "contacts.create", arg: { properties: { email: "a@b.test", firstname: "Ann", lastname: "Lee" }, associations: [] } });
    await hs.createDeal({ name: "D", stage: "qualifiedtobuy", contactExternalId: "contacts-1" }, "key-1");
    expect(calls[2]!.op).toBe("deals.search");
    expect(calls[3]).toMatchObject({ op: "deals.create", arg: { properties: { dealname: "D", dealstage: "qualifiedtobuy", wos_idempotency_key: "key-1" } } });
    await hs.updateDeal("deals-1", { amountCents: 123456 });
    expect(calls.at(-1)).toEqual({ op: "deals.update", arg: { id: "deals-1", arg: { properties: { amount: "1234.56" } } } });
  });
});

describe("tool schemas", () => {
  it("every CRM and inbox tool can be described to the model", () => {
    const reg = new ToolRegistry().register(...crmTools(async () => crm), ...inboxTools(mailbox));
    const specs = reg.specs(reg.list().map((t) => t.name));
    expect(specs).toHaveLength(reg.list().length);
    for (const s of specs) expect(s.inputSchema).toMatchObject({ type: "object" });
  });
});
