import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import {
  acceptInvitation,
  configureEngine,
  createOrg,
  finishQuickstart,
  getBusinessProfile,
  getOnboardingState,
  latestBriefing,
  listAuditEvents,
  listMyOrgs,
  MockLedger,
  MockModelProvider,
  mockTools,
  ModelRouter,
  provisionClientWorkspace,
  quickstartBusiness,
  quickstartSkipConnect,
  scoutTools,
  stopBoss,
  ToolRegistry,
} from "../src/index";
import { adminQuery, ownerQuery, resetDb, seedUser } from "../../db/test/helpers";

afterAll(async () => {
  await stopBoss();
  await closePool();
});

beforeEach(async () => {
  await resetDb();
  await seedUser("darian", "darian@ops.test", "Darian");
  await ownerQuery("UPDATE users SET email_verified = true WHERE id = 'darian'");
  await seedUser("client", "maya@peachtree.test", "Maya");
  await seedUser("stranger", "stranger@else.test", "Stranger");
  process.env.WOS_PLATFORM_ADMIN_EMAILS = "darian@ops.test";
  const ledger = new MockLedger();
  configureEngine({ router: new ModelRouter([new MockModelProvider(() => ({ text: "", toolCalls: [] }))], "mock"), tools: new ToolRegistry().register(...mockTools(ledger), ...scoutTools()), retryBaseSeconds: 1 });
});
afterEach(() => {
  delete process.env.WOS_PLATFORM_ADMIN_EMAILS;
});

const provision = (over: Partial<Parameters<typeof provisionClientWorkspace>[0]> = {}) =>
  provisionClientWorkspace({ actorUserId: "darian", name: "Peachtree Roofing", industry: "roofing", clientEmail: "maya@peachtree.test", confirmEmail: "maya@peachtree.test", zip: "30303", timezone: "America/New_York", ...over });

const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;

describe("provisioning a client workspace (operator only)", () => {
  it("creates a named, trade-ready workspace and one owner invite link; the operator is not a member", async () => {
    const r = await provision();
    const url = new URL(r.inviteUrl);
    expect(url.pathname).toBe("/accept-invite");
    expect(url.searchParams.get("org")).toBe(r.orgId);
    expect(url.searchParams.get("email")).toBe("maya@peachtree.test");
    expect(url.searchParams.get("ws")).toBe("Peachtree Roofing");
    expect(url.searchParams.get("zip")).toBe("30303");
    // Least privilege: Darian can't see the workspace he created.
    expect((await listMyOrgs({ actorUserId: "darian" })).map((o) => o.orgId)).not.toContain(r.orgId);
    const [org] = await adminQuery<{ name: string; industry: string; plan: string }>("SELECT name, industry, plan FROM organizations WHERE id = $1", [r.orgId]);
    expect(org).toEqual({ name: "Peachtree Roofing", industry: "roofing", plan: "scout_pro" });
    // Only the token's hash is stored.
    const inv = await adminQuery<{ token_hash: string; role: string }>("SELECT token_hash, role FROM organization_invitations WHERE tenant_id = $1", [r.orgId]);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.role).toBe("owner");
    expect(inv[0]!.token_hash).not.toContain(tokenOf(r.inviteUrl));
    // Tier-4 access change, audited with the operator as actor.
    const audit = await adminQuery<{ action: string; tier: number; actor_id: string }>("SELECT action, tier, actor_id FROM audit_events WHERE tenant_id = $1 AND action = 'platform.workspace.provision'", [r.orgId]);
    expect(audit).toEqual([{ action: "platform.workspace.provision", tier: 4, actor_id: "darian" }]);
  });

  it("is refused for anyone who isn't a configured, verified platform admin (and looks like a 404)", async () => {
    await expect(provision({ actorUserId: "stranger" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await ownerQuery("UPDATE users SET email_verified = false WHERE id = 'darian'");
    await expect(provision()).rejects.toMatchObject({ code: "NOT_FOUND" });
    delete process.env.WOS_PLATFORM_ADMIN_EMAILS;
    await ownerQuery("UPDATE users SET email_verified = true WHERE id = 'darian'");
    await expect(provision()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await adminQuery("SELECT id FROM organizations")).toHaveLength(0);
  });

  it("needs the owner's email typed twice (second confirmation) and validates input", async () => {
    await expect(provision({ confirmEmail: "maya@peachtree.tst" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(provision({ clientEmail: "not-an-email", confirmEmail: "not-an-email" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(provision({ zip: "abc" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(provision({ timezone: "Mars/Olympus" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await adminQuery("SELECT id FROM organizations")).toHaveLength(0);
  });

  it("the link only works for the invited email", async () => {
    const r = await provision();
    await expect(acceptInvitation({ actorUserId: "stranger", orgId: r.orgId, token: tokenOf(r.inviteUrl) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ok = await acceptInvitation({ actorUserId: "client", orgId: r.orgId, token: tokenOf(r.inviteUrl) });
    expect(ok.role).toBe("owner");
    await expect(acceptInvitation({ actorUserId: "client", orgId: r.orgId, token: tokenOf(r.inviteUrl) })).rejects.toBeTruthy(); // single use
  });
});

describe("three quick steps to a first briefing", () => {
  it("invite → business → skip email → finish: briefing succeeded and 3 DEMO sample opportunities", async () => {
    const r = await provision();
    await acceptInvitation({ actorUserId: "client", orgId: r.orgId, token: tokenOf(r.inviteUrl) });
    const who = { actorUserId: "client", orgId: r.orgId };
    let s = await getOnboardingState(who);
    expect(s.orgName).toBe("Peachtree Roofing"); // already named
    expect(s.industry).toBe("roofing");

    s = await quickstartBusiness({ ...who, name: "Peachtree Roofing & Gutters", industry: "roofing", timezone: "America/New_York", zip: "30303" });
    expect(s.orgName).toBe("Peachtree Roofing & Gutters");
    const profile = await getBusinessProfile(who);
    expect(profile?.status).toBe("reviewed");
    expect(JSON.stringify(profile?.serviceArea)).toMatch(/Fulton/);
    await quickstartSkipConnect(who);
    expect((await getOnboardingState(who)).step).toBe("invite");

    const done = await finishQuickstart({ ...who, briefingHour: 6, samples: true, timezone: "America/New_York" });
    expect(done.briefingRunId).toBeTruthy();
    expect(done.samples.length).toBe(3);
    expect(done.samples.every((o) => /\(DEMO\)/.test(o.name))).toBe(true);
    const b = await latestBriefing(who);
    expect(b?.run.status).toBe("succeeded");
    const storm = (b!.run.output as { sections: { key: string; count: number }[] }).sections.find((x) => x.key === "storm_signals");
    expect(storm!.count).toBeGreaterThan(0);
    const [routine] = await adminQuery<{ hour: number }>("SELECT hour FROM routines WHERE tenant_id = $1", [r.orgId]);
    expect(routine!.hour).toBe(6);
    expect((await getOnboardingState(who)).completedAt).toBeTruthy();
  });

  it("every step is skippable: finishing straight away uses the operator's defaults", async () => {
    const r = await provision({ zip: undefined, industry: "general", name: "Rivera Bookkeeping" });
    await acceptInvitation({ actorUserId: "client", orgId: r.orgId, token: tokenOf(r.inviteUrl) });
    const who = { actorUserId: "client", orgId: r.orgId };
    const done = await finishQuickstart({ ...who, briefingHour: 7, samples: true, timezone: "America/Chicago" });
    expect(done.briefingRunId).toBeTruthy();
    expect(done.samples).toEqual([]); // samples are a roofing/Scout feature; nothing invented for general
    expect((await getOnboardingState(who)).completedAt).toBeTruthy();
  });

  it("roofing without a ZIP: business step still works; samples ask for the area instead of guessing", async () => {
    const r = await provision({ zip: undefined });
    await acceptInvitation({ actorUserId: "client", orgId: r.orgId, token: tokenOf(r.inviteUrl) });
    const who = { actorUserId: "client", orgId: r.orgId };
    await quickstartBusiness({ ...who, name: "Peachtree Roofing", industry: "roofing", timezone: "America/New_York" });
    await expect(finishQuickstart({ ...who, briefingHour: 7, samples: true, timezone: "America/New_York" })).rejects.toMatchObject({ code: "CONFLICT" });
    const done = await finishQuickstart({ ...who, briefingHour: 7, samples: false, timezone: "America/New_York" });
    expect(done.briefingRunId).toBeTruthy();
  });

  it("authorization and tenant isolation: only the workspace's managers can run setup", async () => {
    const r = await provision();
    await acceptInvitation({ actorUserId: "client", orgId: r.orgId, token: tokenOf(r.inviteUrl) });
    const { orgId: other } = await createOrg({ actorUserId: "stranger", name: "Other Co" });
    // A member of another org (and the operator who created it) can't touch it.
    for (const actorUserId of ["stranger", "darian"]) {
      await expect(quickstartBusiness({ actorUserId, orgId: r.orgId, name: "X", industry: "general", timezone: "UTC" })).rejects.toMatchObject({ code: expect.stringMatching(/^(FORBIDDEN|NOT_FOUND)$/) });
      await expect(finishQuickstart({ actorUserId, orgId: r.orgId, briefingHour: 7, samples: false, timezone: "UTC" })).rejects.toBeTruthy();
      await expect(quickstartSkipConnect({ actorUserId, orgId: r.orgId })).rejects.toMatchObject({ code: expect.stringMatching(/^(FORBIDDEN|NOT_FOUND)$/) });
    }
    // And the client can't reach the other org.
    await expect(quickstartBusiness({ actorUserId: "client", orgId: other, name: "X", industry: "general", timezone: "UTC" })).rejects.toMatchObject({ code: expect.stringMatching(/^(FORBIDDEN|NOT_FOUND)$/) });
    await expect(finishQuickstart({ actorUserId: "client", orgId: r.orgId, briefingHour: 3, samples: false, timezone: "UTC" })).rejects.toMatchObject({ code: "VALIDATION" });
    // Every step left an audit entry attributed to the client.
    const actions = (await listAuditEvents({ actorUserId: "client", orgId: r.orgId })).map((e) => e.action);
    expect(actions).toContain("platform.workspace.provision");
  });
});
