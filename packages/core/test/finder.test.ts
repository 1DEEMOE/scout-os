import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, emailIdentities, withTenant } from "@wos/db";
import {
  addSuppression,
  approvalsForReview,
  areaCentre,
  configureEngine,
  connectGoogleMailbox,
  createOrg,
  decideApproval,
  draftFirstOutreach,
  FakeMailProvider,
  inviteMember,
  listOpportunities,
  mockPermitAdapter,
  mockStormAdapter,
  MockModelProvider,
  ModelRouter,
  operatorSetPlan,
  outreachTools,
  pickPermitLeads,
  quickstartBusiness,
  recordPermission,
  requestOutreachApproval,
  runOpportunityFinder,
  runTask,
  scoutTools,
  setMailboxMode,
  stopBoss,
  ToolRegistry,
  type MailboxResolver,
} from "../src/index";
import { adminQuery, resetDb, seedUser } from "../../db/test/helpers";
import { approvalsFor, taskRow } from "./engine-helpers";

let orgId: string;
let mail: FakeMailProvider;
const mailbox: MailboxResolver = async (tenantId) => {
  const [identity] = await withTenant(tenantId, (tx) => tx.select().from(emailIdentities));
  return identity ? { provider: mail, identity } : null;
};
const NOW = new Date("2026-11-06T15:00:00Z");

afterAll(async () => {
  await stopBoss();
  await closePool();
});

beforeEach(async () => {
  await resetDb();
  for (const u of ["owner", "admin", "member", "outsider"]) await seedUser(u, `${u}@example.test`);
  mail = new FakeMailProvider();
  configureEngine({ router: new ModelRouter([new MockModelProvider(() => ({ toolCalls: [] }))], "mock"), tools: new ToolRegistry().register(...scoutTools(), ...outreachTools(mailbox)), mailbox, retryBaseSeconds: 1 });
  orgId = (await createOrg({ actorUserId: "owner", name: "Peachtree Roofing" })).orgId;
  await inviteMember({ actorUserId: "owner", orgId, email: "admin@example.test", role: "admin" });
  await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
  await createOrg({ actorUserId: "outsider", name: "Elsewhere" });
  await operatorSetPlan(orgId, "scout_pro", "test");
  await quickstartBusiness({ actorUserId: "owner", orgId, name: "Peachtree Roofing", industry: "roofing", timezone: "America/New_York", zip: "30303" });
});

describe("signal adapters (MOCK)", () => {
  it("are deterministic, labelled MOCK, and share an area centre so distances line up", async () => {
    const area = { county: "Fulton", state: "GA" };
    const a = await mockStormAdapter.fetch(area, { day: "2026-11-03", now: NOW });
    const b = await mockStormAdapter.fetch(area, { day: "2026-11-03", now: NOW });
    expect(a).toEqual(b);
    expect(mockStormAdapter.mock && mockPermitAdapter.mock).toBe(true);
    expect(a.every((s) => s.comments.includes("(MOCK)"))).toBe(true);
    const c = areaCentre(area);
    const permits = await mockPermitAdapter.fetch(area, { day: "", now: NOW });
    for (const p of permits) expect(Math.abs(p.lat - c.lat)).toBeLessThan(0.1);
    expect(permits.every((p) => p.permitNumber.startsWith("MOCK-"))).toBe(true);
  });

  it("keeps old roofs and skips addresses another contractor just pulled a permit for", async () => {
    const permits = await mockPermitAdapter.fetch({ county: "Fulton", state: "GA" }, { day: "", now: NOW });
    const { leads, skippedRecent } = pickPermitLeads(permits, NOW);
    expect(skippedRecent).toBe(2);
    expect(leads.length).toBe(6);
    expect(leads.every((p) => p.type === "re-roof")).toBe(true);
  });
});

describe("opportunity finder", () => {
  it("finds scored local jobs from storm and permit signals; re-running doesn't duplicate", async () => {
    const r = await runOpportunityFinder({ actorUserId: "owner", orgId, now: NOW });
    expect(r.sources.map((s) => [s.kind, s.mock])).toEqual([["storm", true], ["permit", true]]);
    expect(r.prospectsAdded).toBe(6);
    expect(r.opportunities).toBeGreaterThan(0);
    const opps = await listOpportunities({ actorUserId: "owner", orgId });
    expect(opps.every((o) => o.demo && /\(DEMO\)/.test(o.prospect.name))).toBe(true);
    const again = await runOpportunityFinder({ actorUserId: "owner", orgId, now: NOW });
    expect(again.prospectsAdded).toBe(0);
    expect((await listOpportunities({ actorUserId: "owner", orgId })).length).toBe(opps.length);
    const audit = await adminQuery<{ tier: number }>("SELECT tier FROM audit_events WHERE tenant_id = $1 AND action = 'finder.run'", [orgId]);
    expect(audit.every((a) => a.tier === 1)).toBe(true);
  });

  it("needs a reviewed service area, a manager, and this org", async () => {
    const { orgId: blank } = await createOrg({ actorUserId: "owner", name: "No Area" });
    await operatorSetPlan(blank, "scout_pro", "test");
    await expect(runOpportunityFinder({ actorUserId: "owner", orgId: blank, now: NOW })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(runOpportunityFinder({ actorUserId: "member", orgId, now: NOW })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(runOpportunityFinder({ actorUserId: "outsider", orgId, now: NOW })).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
  });
});

describe("first outreach: drafted for you, sent only after an owner's OK", () => {
  async function emailableOpp() {
    await runOpportunityFinder({ actorUserId: "owner", orgId, now: NOW });
    return (await listOpportunities({ actorUserId: "owner", orgId })).find((o) => o.prospect.email)!;
  }

  it("drafts a specific, no-pressure message with an opt-out, and says why it can't be sent yet", async () => {
    const o = await emailableOpp();
    const d = await draftFirstOutreach({ actorUserId: "member", orgId, opportunityId: o.id });
    expect(d.to).toBe(o.prospect.email);
    expect(d.subject).toMatch(/free roof check/i);
    expect(d.body).toMatch(/^Hi \w+,/);
    expect(d.body).not.toMatch(/\(DEMO\)/);
    expect(d.body).toMatch(/Peachtree Roofing/);
    expect(d.body).toMatch(/reply "stop"/);
    expect(d.canRequest).toBe(false);
    expect(d.blockedReason).toMatch(/no recorded permission/i);
    await expect(requestOutreachApproval({ actorUserId: "owner", orgId, opportunityId: o.id, subject: d.subject, body: d.body })).rejects.toMatchObject({ code: "CONFLICT" });
    const noEmail = (await listOpportunities({ actorUserId: "owner", orgId })).find((x) => !x.prospect.email)!;
    expect((await draftFirstOutreach({ actorUserId: "owner", orgId, opportunityId: noEmail.id })).blockedReason).toMatch(/no email address/i);
  });

  it("owner-only, level 2: the admin can't approve; the owner can; then it sends exactly that message once", async () => {
    const o = await emailableOpp();
    await recordPermission({ actorUserId: "owner", orgId, email: o.prospect.email!, basis: "existing_customer", evidence: "Called us last spring about gutters" });
    const d = await draftFirstOutreach({ actorUserId: "owner", orgId, opportunityId: o.id });
    expect(d.canRequest).toBe(true);
    await expect(requestOutreachApproval({ actorUserId: "member", orgId, opportunityId: o.id, subject: d.subject, body: d.body })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const edited = `${d.body}\n\nP.S. We're local, just off Peachtree St.`;
    const { taskId, approvalId } = await requestOutreachApproval({ actorUserId: "admin", orgId, opportunityId: o.id, subject: d.subject, body: edited });
    const [ap] = await approvalsFor(orgId, taskId);
    expect(ap).toMatchObject({ id: approvalId, tier: 2, toolName: "scout.send_outreach", status: "pending" });
    expect(mail.sent.size).toBe(0); // nothing goes out before the OK
    const view = (await approvalsForReview({ actorUserId: "admin", orgId })).open.find((x) => x.approval.id === approvalId)!;
    expect(view.ownerOnly).toBe(true);
    expect(view.reviewer.kind).toBe("read_only");
    await expect(decideApproval({ actorUserId: "admin", orgId, approvalId, decision: "approve" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    await connectGoogleMailbox({ actorUserId: "owner", orgId, address: "office@peachtree.test", tokens: { refresh_token: "r" }, scopes: [] });
    await setMailboxMode({ actorUserId: "owner", orgId, identityId: (await withTenant(orgId, (tx) => tx.select().from(emailIdentities)))[0]!.id, mode: "send_with_approval" });
    await decideApproval({ actorUserId: "owner", orgId, approvalId, decision: "approve" });
    expect(await runTask(orgId, taskId)).toBe("COMPLETED");
    expect(mail.sent.size).toBe(1);
    const [sent] = [...mail.sent.values()];
    expect(sent!.to).toEqual([o.prospect.email]);
    expect(sent!.body).toBe(edited); // exactly what the owner approved
    const events = await adminQuery<{ kind: string }>("SELECT kind FROM outreach_events WHERE tenant_id = $1 AND opportunity_id = $2", [orgId, o.id]);
    expect(events.map((e) => e.kind)).toEqual(["sent"]);
  });

  it("the do-not-contact list still wins at send time, even after approval", async () => {
    const o = await emailableOpp();
    await recordPermission({ actorUserId: "owner", orgId, email: o.prospect.email!, basis: "existing_customer", evidence: "Past customer, 2023 repair" });
    const d = await draftFirstOutreach({ actorUserId: "owner", orgId, opportunityId: o.id });
    const { taskId, approvalId } = await requestOutreachApproval({ actorUserId: "admin", orgId, opportunityId: o.id, subject: d.subject, body: d.body });
    await connectGoogleMailbox({ actorUserId: "owner", orgId, address: "office@peachtree.test", tokens: { refresh_token: "r" }, scopes: [] });
    await setMailboxMode({ actorUserId: "owner", orgId, identityId: (await withTenant(orgId, (tx) => tx.select().from(emailIdentities)))[0]!.id, mode: "send_with_approval" });
    await decideApproval({ actorUserId: "owner", orgId, approvalId, decision: "approve" });
    await addSuppression({ actorUserId: "owner", orgId, email: o.prospect.email!, reason: "opt_out" });
    expect(await runTask(orgId, taskId)).not.toBe("COMPLETED");
    expect(mail.sent.size).toBe(0);
    expect((await taskRow(orgId, taskId)).error).toMatchObject({ code: "SUPPRESSED" });
  });
});
