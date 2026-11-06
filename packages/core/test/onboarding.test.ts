import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, prospects, withTenant } from "@wos/db";
import {
  applyCsvMapping,
  chooseIndustry,
  clearDemoData,
  configureEngine,
  createOrg,
  finishOnboarding,
  getOnboardingState,
  getPreset,
  latestBriefing,
  loadDemoData,
  lookupZip,
  markConnectLater,
  MockLedger,
  MockModelProvider,
  mockTools,
  scoutTools,
  ModelRouter,
  previewLeadCsv,
  proposeCsvMapping,
  saveBasics,
  skipDataStep,
  skipInvite,
  stopBoss,
  ToolRegistry,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

afterAll(async () => {
  await stopBoss();
  await closePool();
});

beforeEach(async () => {
  await resetDb();
  await seedUser("owner", "owner@example.test", "Olivia Owner");
  const ledger = new MockLedger();
  const model = new MockModelProvider(() => ({ text: "", toolCalls: [] }));
  configureEngine({ router: new ModelRouter([model], "mock"), tools: new ToolRegistry().register(...mockTools(ledger), ...scoutTools()), retryBaseSeconds: 1 });
});

describe("presets", () => {
  it("roofing trial plan includes scout; general uses growth", () => {
    expect(getPreset("roofing").trialPlan).toBe("scout_pro");
    expect(getPreset("general").trialPlan).toBe("growth");
    expect(getPreset("roofing").morningBriefingHourLocal).toBe(7);
  });
});

describe("zip lookup", () => {
  it("resolves known metro ZIPs and never fabricates unknown ones", () => {
    expect(lookupZip("80202")).toMatchObject({ county: "Denver", state: "CO" });
    expect(lookupZip("00000")).toBeNull();
    expect(lookupZip("abc")).toBeNull();
  });
});

describe("csv mapping", () => {
  it("auto-maps common lead headers and flags missing name", () => {
    const csv = "Full Name,Email Address,Zip Code\nAda Lovelace,ada@example.test,80202\n";
    const p = proposeCsvMapping(csv);
    expect(p.mapping["Full Name"]).toBe("fullName");
    expect(p.mapping["Email Address"]).toBe("email");
    expect(p.mapping["Zip Code"]).toBe("postalCode");
    expect(p.missingRequired).toEqual([]);
    expect(p.previewRows).toHaveLength(1);
    const rows = applyCsvMapping(csv, p.mapping);
    expect(rows[0]).toMatchObject({ fullName: "Ada Lovelace", email: "ada@example.test", postalCode: "80202" });
  });
  it("reports missing required when no name column", () => {
    const p = previewLeadCsv("email,phone\na@b.c,1\n");
    expect(p.missingRequired).toContain("fullName");
  });
});

describe("wizard flow", () => {
  it("roofing: industry → basics → DEMO → finish produces a briefing", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Setup Co" });
    let state = await getOnboardingState({ actorUserId: "owner", orgId });
    expect(state.completedAt).toBeNull();
    expect(state.checklist.find((c) => c.id === "industry")?.done).toBe(false);

    state = await chooseIndustry({ actorUserId: "owner", orgId, industry: "roofing" });
    expect(state.industry).toBe("roofing");
    expect(state.plan).toBe("scout_pro");

    state = await saveBasics({
      actorUserId: "owner",
      orgId,
      name: "Summit Roofing",
      timezone: "America/Denver",
      zip: "80202",
    });
    expect(state.orgName).toBe("Summit Roofing");
    expect(state.timezone).toBe("America/Denver");

    const demo = await loadDemoData({ actorUserId: "owner", orgId });
    expect(demo.prospects).toBeGreaterThan(0);
    state = await getOnboardingState({ actorUserId: "owner", orgId });
    expect(state.hasDemoData).toBe(true);

    state = await markConnectLater({ actorUserId: "owner", orgId, skipped: ["gmail", "hubspot", "stripe", "quickbooks"] });
    expect(state.step).toBe("invite");
    state = await skipInvite({ actorUserId: "owner", orgId });
    expect(state.step).toBe("finish");

    const fin = await finishOnboarding({ actorUserId: "owner", orgId });
    expect(fin.routineId).toBeTruthy();
    expect(fin.briefingRunId).toBeTruthy();

    const briefing = await latestBriefing({ actorUserId: "owner", orgId });
    expect(briefing).not.toBeNull();
    expect(briefing!.run.status).toBe("succeeded");

    state = await getOnboardingState({ actorUserId: "owner", orgId });
    expect(state.completedAt).not.toBeNull();
    expect(state.checklist.every((c) => c.done)).toBe(true);
  }, 60_000);

  it("clearDemoData removes only demo-flagged rows", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Demo Roof Co" });
    await chooseIndustry({ actorUserId: "owner", orgId, industry: "roofing" });
    await saveBasics({ actorUserId: "owner", orgId, name: "Demo Roof", timezone: "America/Chicago", zip: "75201" });
    await loadDemoData({ actorUserId: "owner", orgId });
    const before = await withTenant(orgId, async (tx) => tx.select().from(prospects).where(eq(prospects.demo, true)));
    expect(before.length).toBeGreaterThan(0);
    const cleared = await clearDemoData({ actorUserId: "owner", orgId });
    expect(cleared.removed.prospects).toBe(before.length);
    const after = await withTenant(orgId, async (tx) => tx.select().from(prospects).where(eq(prospects.demo, true)));
    expect(after).toHaveLength(0);
  }, 60_000);

  it("general preset skips Scout DEMO and still finishes a briefing", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    await chooseIndustry({ actorUserId: "owner", orgId, industry: "general" });
    await saveBasics({ actorUserId: "owner", orgId, name: "Acme Services", timezone: "America/New_York" });
    await skipDataStep({ actorUserId: "owner", orgId });
    await markConnectLater({ actorUserId: "owner", orgId, skipped: ["gmail"] });
    await skipInvite({ actorUserId: "owner", orgId });
    const fin = await finishOnboarding({ actorUserId: "owner", orgId });
    expect(fin.briefingRunId).toBeTruthy();
    const state = await getOnboardingState({ actorUserId: "owner", orgId });
    expect(state.plan).toBe("growth");
    expect(state.completedAt).not.toBeNull();
  }, 60_000);

  it("unknown ZIP without county fails validation (no fabrication)", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "X Co" });
    await chooseIndustry({ actorUserId: "owner", orgId, industry: "roofing" });
    await expect(
      saveBasics({ actorUserId: "owner", orgId, name: "X", timezone: "UTC", zip: "99999" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
