import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@wos/db";
import {
  addSuppression,
  AppError,
  checkEmailAllowed,
  configureEngine,
  createOrg,
  createTask,
  disqualifyOpportunity,
  getOpportunity,
  importProspects,
  inviteMember,
  listOpportunities,
  markEngaged,
  MockModelProvider,
  ModelRouter,
  operatorSetPlan,
  requestHandoff,
  resetPlanCatalogCache,
  reviewBusinessProfile,
  runScoutScan,
  saveBusinessProfile,
  scoutTools,
  stopBoss,
  ToolRegistry,
  uploadStormReports,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

// Adversarial cases for Scout (directive §17, Phase 9). Each test is an attack
// someone could try; each must fail safely.

let A: string;
let B: string;

async function expectCode(p: Promise<unknown>, code: AppError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
}

const SPC = "Time,Size,Location,County,State,Lat,Lon,Comments\n2105,175,Richardson,Dallas,TX,32.95,-96.76,hail\n";
const today = () => new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

async function readyOrg(org: string, owner: string, csv: string) {
  await saveBusinessProfile({ actorUserId: owner, orgId: org, profile: { vertical: "roofing", services: [], serviceArea: { states: ["TX"], counties: [], center: null } } });
  await reviewBusinessProfile({ actorUserId: owner, orgId: org });
  await uploadStormReports({ actorUserId: owner, orgId: org, csv: SPC, reportDay: today() });
  await importProspects({ actorUserId: owner, orgId: org, csv, label: "list", usageRights: "Our own customer records.", attest: true });
  await withTenant(org, (tx) => runScoutScan(tx, org, { type: "user", id: owner }));
}

beforeEach(async () => {
  await resetDb();
  for (const u of ["alice", "mallory", "member"]) await seedUser(u, `${u}@example.test`);
  configureEngine({ router: new ModelRouter([new MockModelProvider(() => ({}))], "mock"), tools: new ToolRegistry().register(...scoutTools()) });
  A = (await createOrg({ actorUserId: "alice", name: "Victim Roofing" })).orgId;
  B = (await createOrg({ actorUserId: "mallory", name: "Attacker Roofing" })).orgId;
  await inviteMember({ actorUserId: "alice", orgId: A, email: "member@example.test", role: "member" });
  await operatorSetPlan(A, "scout_pro", "test");
  await operatorSetPlan(B, "scout_pro", "test");
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("cross-tenant", () => {
  it("another org can't read, move, hand off or rule out this org's opportunity, even with its id", async () => {
    await readyOrg(A, "alice", "name,email,county,state,lat,lon\nAna,ana@example.test,Dallas,TX,32.95,-96.75\n");
    const [opp] = await listOpportunities({ actorUserId: "alice", orgId: A });
    // Mallory uses her own org (where she is owner) with the victim's opportunity id: RLS hides it.
    await expectCode(getOpportunity({ actorUserId: "mallory", orgId: B, opportunityId: opp!.id }), "NOT_FOUND");
    await expectCode(markEngaged({ actorUserId: "mallory", orgId: B, opportunityId: opp!.id, evidence: "pretend call" }), "NOT_FOUND");
    await expectCode(disqualifyOpportunity({ actorUserId: "mallory", orgId: B, opportunityId: opp!.id, reason: "sabotage" }), "NOT_FOUND");
    await expectCode(requestHandoff({ actorUserId: "mallory", orgId: B, opportunityId: opp!.id }), "NOT_FOUND");
    // And directly against the victim org: not a member.
    await expectCode(getOpportunity({ actorUserId: "mallory", orgId: A, opportunityId: opp!.id }), "NOT_FOUND");
    expect((await listOpportunities({ actorUserId: "alice", orgId: A }))[0]).toMatchObject({ stage: "prospect" });
  });

  it("a scan only sees its own org's storm reports and prospects", async () => {
    await readyOrg(A, "alice", "name,email,county,state,lat,lon\nAna,ana@example.test,Dallas,TX,32.95,-96.75\n");
    // B has a prospect in the same place but no storm reports of its own.
    await saveBusinessProfile({ actorUserId: "mallory", orgId: B, profile: { vertical: "roofing", services: [], serviceArea: { states: ["TX"], counties: [], center: null } } });
    await reviewBusinessProfile({ actorUserId: "mallory", orgId: B });
    await importProspects({ actorUserId: "mallory", orgId: B, csv: "name,county,state,lat,lon\nBen,Dallas,TX,32.95,-96.75\n", label: "x", usageRights: "Our own customer records.", attest: true });
    expect(await withTenant(B, (tx) => runScoutScan(tx, B, { type: "user", id: "mallory" }))).toMatchObject({ examined: 1, created: 0 });
  });

  it("do-not-contact and permissions are per org: B's records never allow or block A's sends", async () => {
    await addSuppression({ actorUserId: "mallory", orgId: B, email: "client@example.test", reason: "manual" });
    expect(await withTenant(A, (tx) => checkEmailAllowed(tx, ["client@example.test"]))).toMatchObject({ allowed: true });
    expect(await withTenant(B, (tx) => checkEmailAllowed(tx, ["client@example.test"]))).toMatchObject({ allowed: false, reason: "suppressed" });
  });
});

describe("consent gate", () => {
  it("can't be dodged with case, display names or whitespace", async () => {
    await addSuppression({ actorUserId: "alice", orgId: A, email: "Ana@Example.TEST", reason: "opt_out" });
    for (const r of ["ana@example.test", "ANA@EXAMPLE.TEST", "Ana Diaz <Ana@Example.Test>", "  ana@example.test  "]) {
      expect(await withTenant(A, (tx) => checkEmailAllowed(tx, [r])), r).toMatchObject({ allowed: false, reason: "suppressed" });
    }
    // One blocked recipient blocks the whole message.
    expect(await withTenant(A, (tx) => checkEmailAllowed(tx, ["ok@example.test", "ana@example.test"]))).toMatchObject({ allowed: false });
  });

  it("a Scout prospect without permission is blocked whatever the casing", async () => {
    await readyOrg(A, "alice", "name,email,county,state,lat,lon\nAna,Ana@Example.test,Dallas,TX,32.95,-96.75\n");
    expect(await withTenant(A, (tx) => checkEmailAllowed(tx, ["ANA@example.TEST"]))).toMatchObject({ allowed: false, reason: "no_permission" });
  });
});

describe("tasks API can't smuggle a direct plan or a handoff", () => {
  it("createTask ignores a forged direct plan, delegation or opportunity link from the caller", async () => {
    const { taskId } = await createTask({
      actorUserId: "member", orgId: A, intent: "do it",
      input: { agentKind: "sales", delegation: { chainId: "x" }, scoutOpportunityId: "00000000-0000-4000-8000-000000000000" },
      ...({ plan: { direct: [{ tool: "crm.create_deal", args: {} }] } } as object),
    });
    const [t] = await withTenant(A, async (tx) => (await tx.execute(sql`SELECT plan, input FROM tasks WHERE id = ${taskId}`)).rows as { plan: unknown; input: Record<string, unknown> }[]);
    expect(t!.plan).toBeNull();
    expect(t!.input).not.toHaveProperty("delegation");
    // Setting handoff_task_id is not possible through the task; opportunities stay unlinked.
    const n = await withTenant(A, async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM opportunities WHERE handoff_task_id IS NOT NULL`)).rows[0] as { n: number });
    expect(n.n).toBe(0);
  });
});

describe("lifecycle races", () => {
  it("two people moving the same opportunity at once: exactly one wins", async () => {
    await readyOrg(A, "alice", "name,email,county,state,lat,lon\nAna,ana@example.test,Dallas,TX,32.95,-96.75\n");
    const [opp] = await listOpportunities({ actorUserId: "alice", orgId: A });
    const results = await Promise.allSettled([
      markEngaged({ actorUserId: "alice", orgId: A, opportunityId: opp!.id, evidence: "Alice: she called." }),
      markEngaged({ actorUserId: "member", orgId: A, opportunityId: opp!.id, evidence: "Member: she called too." }),
      markEngaged({ actorUserId: "alice", orgId: A, opportunityId: opp!.id, evidence: "Alice again: double click." }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "CONFLICT" });
    const events = await withTenant(A, async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM opportunity_events WHERE from_stage = 'prospect'`)).rows[0] as { n: number });
    expect(events.n).toBe(1);
  });
});

describe("quota races", () => {
  it("concurrent imports can't exceed the monthly row allowance together", async () => {
    process.env.SCOUT_PLAN_CATALOG = JSON.stringify([
      { id: "starter", label: "Starter", features: ["core_agents"], limits: { seats: 5, tasks: 50, "scout.opportunities": 0, "scout.prospect_rows": 0 } },
      { id: "scout_pro", label: "Scout Pro", features: ["core_agents", "scout"], limits: { seats: 5, tasks: 50, "scout.opportunities": 10, "scout.prospect_rows": 5 } },
    ]);
    resetPlanCatalogCache();
    try {
      const file = (p: string) => `name,county,state\n${[1, 2, 3].map((i) => `${p}${i},Dallas,TX`).join("\n")}\n`;
      const results = await Promise.allSettled(["a", "b", "c"].map((p) => importProspects({ actorUserId: "alice", orgId: A, csv: file(p), label: p, usageRights: "Our own customer records.", attest: true })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1); // 3 rows fit; a second file would make 6 > 5
      const n = await withTenant(A, async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM prospects`)).rows[0] as { n: number });
      expect(n.n).toBe(3);
    } finally {
      delete process.env.SCOUT_PLAN_CATALOG;
      resetPlanCatalogCache();
    }
  });
});

describe("hostile files", () => {
  it("stores spreadsheet formulas and markup as plain text, strips control characters, and caps lengths", async () => {
    const longName = "X".repeat(5000);
    await importProspects({
      actorUserId: "alice", orgId: A, label: "hostile", usageRights: "Our own customer records.", attest: true,
      csv: `name,email,county,state\n"=HYPERLINK(""http://evil.test"",""x"")",a@example.test,Dallas,TX\n<script>alert(1)</script>,b@example.test,Dallas,TX\n"Robert'); DROP TABLE prospects;--",c@example.test,Dallas,TX\n${longName},d@example.test,Dallas,TX\n"Null\u0000Byte",e@example.test,Dallas,TX\n`,
    });
    const names = (await withTenant(A, (tx) => tx.execute(sql`SELECT name FROM prospects ORDER BY source_row`))).rows.map((r) => (r as { name: string }).name);
    expect(names[0]).toBe('=HYPERLINK("http://evil.test","x")'); // text; the app never exports CSV and React escapes on render
    expect(names[1]).toBe("<script>alert(1)</script>");
    expect(names[2]).toBe("Robert'); DROP TABLE prospects;--"); // parameterized: the table is still here
    expect(names[3]).toHaveLength(200);
    expect(names[4]).toBe("Null Byte");
  });

  it("refuses oversized and over-long files before doing any work", async () => {
    await expectCode(importProspects({ actorUserId: "alice", orgId: A, label: "big", usageRights: "Our own customer records.", attest: true, csv: "name\n" + "a\n".repeat(5001) }), "VALIDATION");
    await expectCode(importProspects({ actorUserId: "alice", orgId: A, label: "huge", usageRights: "Our own customer records.", attest: true, csv: "x".repeat(2_000_001) }), "VALIDATION");
    await expectCode(uploadStormReports({ actorUserId: "alice", orgId: A, reportDay: "2026-11-01", csv: "x".repeat(2_000_001) }), "VALIDATION");
  });

  it("a storm report file with junk, wrong sections or impossible values stores nothing bad", async () => {
    const junk = "Time,Size,Location,County,State,Lat,Lon,Comments\n2105,99999,X,Dallas,TX,32.1,-96.1,huge\n9999,100,X,Dallas,TX,32.1,-96.1,bad time\n2105,100,X,Dallas,Texas,32.1,-96.1,bad state\nTime,Bogus,Location,County,State,Lat,Lon,Comments\n2105,100,X,Dallas,TX,32.1,-96.1,unknown section\n";
    await expectCode(uploadStormReports({ actorUserId: "alice", orgId: A, reportDay: "2026-11-01", csv: junk }), "VALIDATION");
    const ok = "Time,Size,Location,County,State,Lat,Lon,Comments\n2105,175,BadLat,Dallas,TX,999,-96,bad lat\n2106,100,Ok,Dallas,TX,32.00,-96.00,fine\n";
    const r = await uploadStormReports({ actorUserId: "alice", orgId: A, reportDay: "2026-11-01", csv: junk + ok });
    expect(r.added).toBe(2); // the bad-latitude row is kept without coordinates (county match only); junk rows are rejected
    expect(r.rejected.length).toBeGreaterThanOrEqual(4);
    const rows = (await withTenant(A, (tx) => tx.execute(sql`SELECT lat, lon FROM signal_observations ORDER BY location`))).rows;
    expect(rows).toEqual(expect.arrayContaining([{ lat: null, lon: null }, { lat: 32, lon: -96 }]));
  });
});

describe("roles", () => {
  it("members can't change setup, import, upload or record permissions; viewers can't act at all", async () => {
    await seedUser("viewer", "viewer@example.test");
    await inviteMember({ actorUserId: "alice", orgId: A, email: "viewer@example.test", role: "viewer" });
    await expectCode(reviewBusinessProfile({ actorUserId: "member", orgId: A }), "FORBIDDEN");
    await expectCode(uploadStormReports({ actorUserId: "member", orgId: A, csv: SPC, reportDay: "2026-11-01" }), "FORBIDDEN");
    await expectCode(listOpportunities({ actorUserId: "viewer", orgId: A }), "FORBIDDEN");
    await expectCode(addSuppression({ actorUserId: "viewer", orgId: A, email: "x@example.test", reason: "manual" }), "FORBIDDEN");
  });
});

describe("phase 9 checklist extras", () => {
  it("a starter plan cannot use Scout APIs even with a forged operator-looking plan string on the org row", async () => {
    await operatorSetPlan(A, "starter", "test");
    // Direct DB tamper: write a fake plan code that is not in the catalog.
    await withTenant(A, (tx) => tx.execute(sql`UPDATE organizations SET plan = 'scout_pro_forged'`));
    await expectCode(saveBusinessProfile({ actorUserId: "alice", orgId: A, profile: { vertical: "roofing", services: [], serviceArea: { states: ["TX"], counties: [], center: null } } }), "UPGRADE_REQUIRED");
    await expectCode(importProspects({ actorUserId: "alice", orgId: A, csv: "name,county,state\nA,Dallas,TX\n", label: "x", usageRights: "Our own customer records.", attest: true }), "UPGRADE_REQUIRED");
  });

  it("suppression blocks outreach even when a permission row also exists for the same email", async () => {
    await readyOrg(A, "alice", "name,email,county,state,lat,lon\nAna,ana@example.test,Dallas,TX,32.95,-96.75\n");
    const { recordPermission, addSuppression } = await import("../src/index");
    await recordPermission({ actorUserId: "alice", orgId: A, email: "ana@example.test", basis: "existing_customer", evidence: "Past roofing job in 2025" });
    await addSuppression({ actorUserId: "alice", orgId: A, email: "ana@example.test", reason: "opt_out" });
    expect(await withTenant(A, (tx) => checkEmailAllowed(tx, ["ana@example.test"]))).toMatchObject({ allowed: false, reason: "suppressed" });
  });
});

describe("phase 9 kill switch + tier rules", () => {
  it("while agents are paused, a queued Scout scan does not advance", async () => {
    const { requestScan, setAgentsPaused, runTask } = await import("../src/index");
    await saveBusinessProfile({ actorUserId: "alice", orgId: A, profile: { vertical: "roofing", services: [], serviceArea: { states: ["TX"], counties: [], center: null } } });
    await reviewBusinessProfile({ actorUserId: "alice", orgId: A });
    await setAgentsPaused({ actorUserId: "alice", orgId: A, paused: true });
    const { taskId } = await requestScan({ actorUserId: "alice", orgId: A });
    expect(await runTask(A, taskId)).toBe("REQUESTED");
    await setAgentsPaused({ actorUserId: "alice", orgId: A, paused: false });
  });

  it("members cannot pause agents; only owners can", async () => {
    const { setAgentsPaused } = await import("../src/index");
    await expectCode(setAgentsPaused({ actorUserId: "member", orgId: A, paused: true }), "FORBIDDEN");
  });
});
