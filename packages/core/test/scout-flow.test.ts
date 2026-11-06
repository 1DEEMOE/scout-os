import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, emailIdentities, withTenant } from "@wos/db";
import {
  addSuppression,
  AGENT_PRESETS,
  AppError,
  configureEngine,
  connectGoogleMailbox,
  createAgent,
  createOrg,
  crmTools,
  decideApproval,
  disqualifyOpportunity,
  FakeCrmProvider,
  FakeMailProvider,
  getOpportunity,
  importProspects,
  inboxTools,
  memoryTools,
  inviteMember,
  listOpportunities,
  markEngaged,
  MockModelProvider,
  ModelRouter,
  operatorSetPlan,
  qualifyOpportunity,
  recordPermission,
  requestHandoff,
  requestScan,
  requestSendDraft,
  reviewBusinessProfile,
  revokePermission,
  runTask,
  saveBusinessProfile,
  scoutAnalytics,
  scoutTools,
  setMailboxMode,
  stopBoss,
  syncInbox,
  ToolRegistry,
  triageConversation,
  uploadStormReports,
  type MailboxResolver,
  type ModelResponse,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";
import { approvalsFor, taskRow } from "./engine-helpers";

let orgId: string;
let mail: FakeMailProvider;
let crm: FakeCrmProvider;
let plan: Partial<ModelResponse>;

const mailbox: MailboxResolver = async (tenantId) => {
  const [identity] = await withTenant(tenantId, (tx) => tx.select().from(emailIdentities));
  return identity ? { provider: mail, identity } : null;
};

async function expectCode(p: Promise<unknown>, code: AppError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
}

// Storm reports dated relative to now so the 30-day lookback always includes them.
function recentSpc() {
  const d = new Date(Date.now() - 3 * 86_400_000);
  const day = d.toISOString().slice(0, 10);
  return { day, csv: "Time,Size,Location,County,State,Lat,Lon,Comments\n2105,175,2 W Richardson,Dallas,TX,32.95,-96.76,Golf ball size hail.\n" };
}

const PROSPECTS = `name,email,address,city,county,state,lat,lon
Ana Diaz,ana@example.test,1 Elm St,Richardson,Dallas,TX,32.96,-96.74
Bo Reed,bo@example.test,5 Main St,Richardson,Dallas,TX,32.95,-96.75
`;

async function scoutReady() {
  await saveBusinessProfile({ actorUserId: "owner", orgId, profile: { vertical: "roofing", services: ["Roof inspection"], serviceArea: { states: ["TX"], counties: [], center: null } } });
  await reviewBusinessProfile({ actorUserId: "owner", orgId });
  const s = recentSpc();
  await uploadStormReports({ actorUserId: "owner", orgId, csv: s.csv, reportDay: s.day });
  await importProspects({ actorUserId: "owner", orgId, csv: PROSPECTS, label: "Past customers", usageRights: "Our own past-customer list.", attest: true });
}

async function scanNow() {
  const { taskId } = await requestScan({ actorUserId: "member", orgId });
  return { taskId, state: await runTask(orgId, taskId) };
}

const opp = async (name: string) => (await listOpportunities({ actorUserId: "owner", orgId })).find((o) => o.prospect.name === name)!;

beforeEach(async () => {
  await resetDb();
  for (const u of ["owner", "member"]) await seedUser(u, `${u}@example.test`);
  mail = new FakeMailProvider();
  crm = new FakeCrmProvider();
  plan = { toolCalls: [] };
  configureEngine({
    router: new ModelRouter([new MockModelProvider((r) => (r.purpose === "classify" ? { text: "inbox" } : plan))], "mock"),
    tools: new ToolRegistry().register(...crmTools(async () => crm), ...inboxTools(mailbox), ...scoutTools(), ...memoryTools()),
    mailbox,
    crm: async () => crm,
    retryBaseSeconds: 1,
  });
  orgId = (await createOrg({ actorUserId: "owner", name: "Roof Co" })).orgId;
  await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
  for (const spec of AGENT_PRESETS.filter((p) => p.kind !== "finance")) await createAgent({ actorUserId: "owner", orgId, spec });
  await operatorSetPlan(orgId, "scout_pro", "test");
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("Scout scan as an agent task", () => {
  it("reviewing the profile sets up the Scout agent; the scan runs through the task engine and is attributed to it", async () => {
    await scoutReady();
    const { taskId, state } = await scanNow();
    expect(state).toBe("COMPLETED");
    const t = await taskRow(orgId, taskId);
    expect((t.plan as { model: { provider: string } }).model.provider).toBe("direct"); // no model in the loop
    expect(await listOpportunities({ actorUserId: "member", orgId })).toHaveLength(2);
    const audit = await withTenant(orgId, async (tx) => (await tx.execute(sql`SELECT a.actor_type, g.kind FROM audit_events a JOIN agents g ON g.id::text = a.actor_id WHERE a.action = 'scout.scan'`)).rows);
    expect(audit).toEqual([{ actor_type: "agent", kind: "scout" }]);
  });

  it("refuses to queue a scan before the profile is reviewed", async () => {
    await saveBusinessProfile({ actorUserId: "owner", orgId, profile: { vertical: "roofing", services: [], serviceArea: { states: ["TX"], counties: [], center: null } } });
    await expectCode(requestScan({ actorUserId: "member", orgId }), "CONFLICT");
  });

  it("a downgrade after the scan was queued stops it at execution time", async () => {
    await scoutReady();
    const { taskId } = await requestScan({ actorUserId: "member", orgId });
    await operatorSetPlan(orgId, "growth", "downgraded");
    expect(await runTask(orgId, taskId)).toBe("FAILED");
    expect((await taskRow(orgId, taskId)).error).toMatchObject({ message: expect.stringMatching(/isn't included in the Growth plan/) });
    const n = await withTenant(orgId, async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM opportunities`)).rows[0] as { n: number });
    expect(n.n).toBe(0);
    const denied = await withTenant(orgId, async (tx) => (await tx.execute(sql`SELECT actor_type FROM audit_events WHERE action = 'scout.scan' AND outcome = 'denied'`)).rows);
    expect(denied).toEqual([{ actor_type: "agent" }]);
  });
});

describe("lifecycle", () => {
  beforeEach(async () => {
    await scoutReady();
    await scanNow();
  });

  it("can't skip stages, and each move needs its evidence", async () => {
    const ana = await opp("Ana Diaz");
    await expectCode(qualifyOpportunity({ actorUserId: "member", orgId, opportunityId: ana.id, answers: { owns_property: true, wants_inspection: true, in_service_area: true, timeline: "this month" } }), "CONFLICT");
    await expectCode(requestHandoff({ actorUserId: "member", orgId, opportunityId: ana.id }), "CONFLICT");
    await expectCode(markEngaged({ actorUserId: "member", orgId, opportunityId: ana.id, evidence: "" }), "VALIDATION");
    await markEngaged({ actorUserId: "member", orgId, opportunityId: ana.id, evidence: "She called the office on Monday." });
    await expectCode(qualifyOpportunity({ actorUserId: "member", orgId, opportunityId: ana.id, answers: { owns_property: true } }), "VALIDATION");
    await qualifyOpportunity({ actorUserId: "member", orgId, opportunityId: ana.id, answers: { owns_property: true, wants_inspection: true, in_service_area: true, timeline: "this month" }, note: "Wants Friday." });
    const d = await getOpportunity({ actorUserId: "member", orgId, opportunityId: ana.id });
    expect(d.events.map((e) => [e.fromStage, e.toStage, e.actorId])).toEqual([[null, "prospect", expect.any(String)], ["prospect", "engaged", "member"], ["engaged", "qualified", "member"]]);
    expect(d.events[1]!.evidence).toBe("She called the office on Monday.");
  });

  it("disqualifies with a reason, from any open stage, and viewers of another org can't read it", async () => {
    const bo = await opp("Bo Reed");
    await expectCode(disqualifyOpportunity({ actorUserId: "member", orgId, opportunityId: bo.id, reason: "" }), "VALIDATION");
    await disqualifyOpportunity({ actorUserId: "member", orgId, opportunityId: bo.id, reason: "Renter, not the owner" });
    expect((await opp("Bo Reed"))).toMatchObject({ stage: "disqualified", disqualifiedReason: "Renter, not the owner" });
    await expectCode(markEngaged({ actorUserId: "member", orgId, opportunityId: bo.id, evidence: "called again" }), "CONFLICT");
    await expectCode(getOpportunity({ actorUserId: "member", orgId, opportunityId: "not-a-uuid" }), "NOT_FOUND");
  });
});

describe("inbound email from a prospect", () => {
  it("moves them to engaged and records an inbound-inquiry permission (but not for do-not-contact)", async () => {
    await scoutReady();
    await scanNow();
    await addSuppression({ actorUserId: "member", orgId, email: "bo@example.test", reason: "opt_out" });
    await connectGoogleMailbox({ actorUserId: "owner", orgId, address: "office@roof.test", tokens: { refresh_token: "r" }, scopes: [] });
    mail.inbox.push({ externalId: "m1", threadId: "t1", from: "Ana Diaz <Ana@Example.test>", to: ["office@roof.test"], subject: "Roof check?", body: "Can you look at my roof?", sentAt: new Date(), direction: "inbound" });
    mail.inbox.push({ externalId: "m2", threadId: "t2", from: "bo@example.test", to: ["office@roof.test"], subject: "Hi", body: "Hello", sentAt: new Date(), direction: "inbound" });
    await syncInbox({ actorUserId: "member", orgId });
    const ana = await getOpportunity({ actorUserId: "member", orgId, opportunityId: (await opp("Ana Diaz")).id });
    expect(ana.opportunity.stage).toBe("engaged");
    expect(ana.events.at(-1)).toMatchObject({ actorType: "system", actorId: "inbox", evidence: expect.stringMatching(/Inbound email from ana@example.test/) });
    expect(ana.permission).toMatchObject({ basis: "inbound_inquiry", recordedBy: "system:inbox" });
    const bo = await getOpportunity({ actorUserId: "member", orgId, opportunityId: (await opp("Bo Reed")).id });
    expect(bo.permission).toBeNull();
    expect(bo.suppressed).toMatchObject({ reason: "opt_out" });
  });
});

describe("handoff to Pipeline", () => {
  async function qualified(name: string) {
    const o = await opp(name);
    await markEngaged({ actorUserId: "member", orgId, opportunityId: o.id, evidence: "They called us." });
    await qualifyOpportunity({ actorUserId: "member", orgId, opportunityId: o.id, answers: { owns_property: true, wants_inspection: true, in_service_area: true, timeline: "soon" } });
    return o.id;
  }
  beforeEach(async () => {
    await scoutReady();
    await scanNow();
  });

  it("goes through approvals (the prospect's details are external data) and only then becomes an opportunity", async () => {
    const id = await qualified("Ana Diaz");
    const { taskId } = await requestHandoff({ actorUserId: "member", orgId, opportunityId: id });
    await expectCode(requestHandoff({ actorUserId: "member", orgId, opportunityId: id }), "CONFLICT"); // already in progress
    expect(await runTask(orgId, taskId)).toBe("WAITING_FOR_APPROVAL");
    const approvals = await approvalsFor(orgId, taskId);
    expect(approvals.map((a) => a.toolName).sort()).toEqual(["crm.add_note", "crm.create_deal", "crm.upsert_contact"]);
    expect(crm.contacts.size).toBe(0); // nothing written before approval
    expect((await opp("Ana Diaz")).stage).toBe("qualified");
    for (const a of approvals) await decideApproval({ actorUserId: "owner", orgId, approvalId: a.id, decision: "approve" });
    expect(await runTask(orgId, taskId)).toBe("COMPLETED");
    expect(crm.contacts.size).toBe(1);
    const d = await getOpportunity({ actorUserId: "member", orgId, opportunityId: id });
    expect(d.opportunity.stage).toBe("opportunity");
    expect(d.events.at(-1)).toMatchObject({ fromStage: "qualified", toStage: "opportunity", actorId: "pipeline-handoff", evidence: expect.stringContaining(taskId) });
  });

  it("a rejected handoff leaves the opportunity qualified and allows a new request", async () => {
    const id = await qualified("Ana Diaz");
    const { taskId } = await requestHandoff({ actorUserId: "member", orgId, opportunityId: id });
    await runTask(orgId, taskId);
    const [first] = await approvalsFor(orgId, taskId);
    await decideApproval({ actorUserId: "owner", orgId, approvalId: first!.id, decision: "reject" });
    await runTask(orgId, taskId);
    expect((await taskRow(orgId, taskId)).state).toBe("FAILED");
    const d = await getOpportunity({ actorUserId: "member", orgId, opportunityId: id });
    expect(d.opportunity).toMatchObject({ stage: "qualified", handoffTaskId: null });
    await expect(requestHandoff({ actorUserId: "member", orgId, opportunityId: id })).resolves.toHaveProperty("taskId");
  });
});

describe("follow-up email gate", () => {
  async function engagedAnaWithDraft() {
    await scoutReady();
    await scanNow();
    await connectGoogleMailbox({ actorUserId: "owner", orgId, address: "office@roof.test", tokens: { refresh_token: "r" }, scopes: [] });
    await setMailboxMode({ actorUserId: "owner", orgId, identityId: (await withTenant(orgId, (tx) => tx.select().from(emailIdentities)))[0]!.id, mode: "send_with_approval" });
    mail.inbox.push({ externalId: "m1", threadId: "t1", from: "Ana Diaz <ana@example.test>", to: ["office@roof.test"], subject: "Roof check?", body: "Can you look at my roof?", sentAt: new Date(), direction: "inbound" });
    await syncInbox({ actorUserId: "member", orgId });
    const conv = (await withTenant(orgId, (tx) => tx.execute(sql`SELECT id FROM conversations`))).rows[0] as { id: string };
    plan = { toolCalls: [{ name: "inbox.create_draft", input: { conversationId: conv.id, body: "Happy to take a look. Does Friday work?" } }] };
    const { taskId } = await triageConversation({ actorUserId: "member", orgId, conversationId: conv.id });
    expect(await runTask(orgId, taskId)).toBe("COMPLETED");
    return conv.id;
  }

  async function approveSend(conversationId: string) {
    const { taskId } = await requestSendDraft({ actorUserId: "member", orgId, conversationId });
    expect(await runTask(orgId, taskId)).toBe("WAITING_FOR_APPROVAL");
    for (const a of await approvalsFor(orgId, taskId)) await decideApproval({ actorUserId: "owner", orgId, approvalId: a.id, decision: "approve" });
    return taskId;
  }

  const outreach = () => withTenant(orgId, async (tx) => (await tx.execute(sql`SELECT kind, reason, recipient, opportunity_id IS NOT NULL AS linked FROM outreach_events ORDER BY created_at`)).rows);

  it("sends to a prospect who wrote in (permission recorded) and records the send against the opportunity", async () => {
    const conv = await engagedAnaWithDraft();
    const taskId = await approveSend(conv);
    expect(await runTask(orgId, taskId)).toBe("COMPLETED");
    expect(mail.sendCalls).toBe(1);
    expect(await outreach()).toEqual([{ kind: "sent", reason: null, recipient: "ana@example.test", linked: true }]);
  });

  it("refuses up front when the person is on the do-not-contact list", async () => {
    const conv = await engagedAnaWithDraft();
    await addSuppression({ actorUserId: "member", orgId, email: "ana@example.test", reason: "opt_out" });
    await expectCode(requestSendDraft({ actorUserId: "member", orgId, conversationId: conv }), "CONFLICT");
  });

  it("blocks at send time if they opt out after the approval, and records the block (nothing sent)", async () => {
    const conv = await engagedAnaWithDraft();
    const taskId = await approveSend(conv);
    await addSuppression({ actorUserId: "member", orgId, email: "ana@example.test", reason: "opt_out" });
    expect(await runTask(orgId, taskId)).toBe("FAILED");
    expect((await taskRow(orgId, taskId)).error).toMatchObject({ message: expect.stringMatching(/do-not-contact/) });
    expect(mail.sendCalls).toBe(0);
    expect(await outreach()).toEqual([{ kind: "blocked", reason: "suppressed", recipient: "ana@example.test", linked: true }]);
  });

  it("blocks a Scout prospect whose permission was revoked", async () => {
    const conv = await engagedAnaWithDraft();
    const taskId = await approveSend(conv);
    await revokePermission({ actorUserId: "member", orgId, email: "ana@example.test" });
    expect(await runTask(orgId, taskId)).toBe("FAILED");
    expect(mail.sendCalls).toBe(0);
    expect(await outreach()).toEqual([{ kind: "blocked", reason: "no_permission", recipient: "ana@example.test", linked: true }]);
  });

  it("permissions: only managers record them, never for do-not-contact addresses; opting out works even without Scout", async () => {
    await expectCode(recordPermission({ actorUserId: "member", orgId, email: "x@example.test", basis: "existing_customer", evidence: "Customer since 2021" }), "FORBIDDEN");
    await recordPermission({ actorUserId: "owner", orgId, email: "X@example.test", basis: "existing_customer", evidence: "Customer since 2021" });
    await expectCode(recordPermission({ actorUserId: "owner", orgId, email: "x@example.test", basis: "existing_customer", evidence: "again please" }), "CONFLICT");
    await operatorSetPlan(orgId, "starter", "downgrade");
    await addSuppression({ actorUserId: "member", orgId, email: "x@example.test", reason: "opt_out" });
    const perms = await withTenant(orgId, async (tx) => (await tx.execute(sql`SELECT revoked_by FROM communication_permissions WHERE value = 'x@example.test'`)).rows);
    expect(perms).toEqual([{ revoked_by: "member" }]); // opting out revokes permission too
    await operatorSetPlan(orgId, "scout_pro", "up");
    await expectCode(recordPermission({ actorUserId: "owner", orgId, email: "x@example.test", basis: "express_written_consent", evidence: "Signed form" }), "CONFLICT");
  });

  it("ordinary replies to people who aren't Scout prospects are unaffected", async () => {
    await connectGoogleMailbox({ actorUserId: "owner", orgId, address: "office@roof.test", tokens: { refresh_token: "r" }, scopes: [] });
    await setMailboxMode({ actorUserId: "owner", orgId, identityId: (await withTenant(orgId, (tx) => tx.select().from(emailIdentities)))[0]!.id, mode: "send_with_approval" });
    mail.inbox.push({ externalId: "m9", threadId: "t9", from: "client@customer.test", to: ["office@roof.test"], subject: "Invoice", body: "Resend please", sentAt: new Date(), direction: "inbound" });
    await syncInbox({ actorUserId: "member", orgId });
    const conv = (await withTenant(orgId, (tx) => tx.execute(sql`SELECT id FROM conversations`))).rows[0] as { id: string };
    plan = { toolCalls: [{ name: "inbox.create_draft", input: { conversationId: conv.id, body: "Attached." } }] };
    const t = await triageConversation({ actorUserId: "member", orgId, conversationId: conv.id });
    await runTask(orgId, t.taskId);
    const taskId = await approveSend(conv.id);
    expect(await runTask(orgId, taskId)).toBe("COMPLETED");
    expect(await outreach()).toEqual([]);
  });
});


describe("analytics", () => {
  it("labels every number, counts the funnel from records, and only estimates from the customer's own figures", async () => {
    await scoutReady();
    await scanNow();
    const empty = await scoutAnalytics({ actorUserId: "member", orgId, days: 30 });
    const get = (a: typeof empty, k: string) => [...a.funnel, ...a.money].find((m) => m.key === k)!;
    expect(get(empty, "matched")).toMatchObject({ value: 2, basis: "observed" });
    expect(get(empty, "data_cost")).toMatchObject({ value: null, basis: "customer-reported" });
    expect(get(empty, "cost_per_opportunity")).toMatchObject({ value: null, basis: "estimated" });
    expect(get(empty, "pipeline_value")).toMatchObject({ value: null, basis: "estimated" });
    for (const m of [...empty.funnel, ...empty.money]) expect(["observed", "customer-reported", "estimated"]).toContain(m.basis);

    // Hand Ana off, then record a won deal and a paid invoice for her in the CRM/finance records.
    const ana = await opp("Ana Diaz");
    await markEngaged({ actorUserId: "member", orgId, opportunityId: ana.id, evidence: "Called us." });
    await qualifyOpportunity({ actorUserId: "member", orgId, opportunityId: ana.id, answers: { owns_property: true, wants_inspection: true, in_service_area: true, timeline: "soon" } });
    const { taskId } = await requestHandoff({ actorUserId: "member", orgId, opportunityId: ana.id });
    await runTask(orgId, taskId);
    for (const a of await approvalsFor(orgId, taskId)) await decideApproval({ actorUserId: "owner", orgId, approvalId: a.id, decision: "approve" });
    expect(await runTask(orgId, taskId)).toBe("COMPLETED");
    await withTenant(orgId, async (tx) => {
      await tx.execute(sql`UPDATE crm_records SET stage = 'closedwon'`);
      await tx.execute(sql`INSERT INTO invoices (tenant_id, provider, external_id, status, amount_due_cents, customer_email) VALUES (${orgId}, 'fake', 'in_1', 'paid', 1200000, 'Ana@Example.test')`);
      await tx.execute(sql`INSERT INTO invoices (tenant_id, provider, external_id, status, amount_due_cents, customer_email) VALUES (${orgId}, 'fake', 'in_2', 'paid', 99999, 'someone-else@example.test')`);
    });
    await saveBusinessProfile({ actorUserId: "owner", orgId, profile: { vertical: "roofing", services: ["Roof inspection"], serviceArea: { states: ["TX"], counties: [], center: null }, settings: { monthlyDataCostCents: 30000, averageJobValueCents: 1000000 } } });
    const a = await scoutAnalytics({ actorUserId: "member", orgId, days: 30 });
    expect(get(a, "engaged").value).toBe(1);
    expect(get(a, "qualified").value).toBe(1);
    expect(get(a, "opportunities").value).toBe(1);
    expect(get(a, "won")).toMatchObject({ value: 1, basis: "observed", note: expect.stringMatching(/Attribution unverified/) });
    expect(get(a, "revenue")).toMatchObject({ value: 1200000, basis: "observed" }); // only the handed-off person's invoice
    expect(get(a, "data_cost")).toMatchObject({ value: 30000, basis: "customer-reported" });
    expect(get(a, "cost_per_opportunity")).toMatchObject({ value: 30000, basis: "estimated" }); // ($300 + $0 AI) / 1
    expect(get(a, "pipeline_value")).toMatchObject({ value: 2000000, basis: "estimated" }); // (1 qualified + 1 opportunity) × $10,000
  });

  it("is refused without Scout", async () => {
    await operatorSetPlan(orgId, "growth", "test");
    await expectCode(scoutAnalytics({ actorUserId: "member", orgId }), "UPGRADE_REQUIRED");
  });
});
