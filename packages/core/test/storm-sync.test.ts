import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@wos/db";
import {
  activeJournal,
  configureEngine,
  createOrg,
  currentSpcReportDay,
  listDeadLetters,
  listSignals,
  MockModelProvider,
  ModelRouter,
  operatorSetPlan,
  registerIntegrationHandlers,
  replayDeadLetter,
  reviewBusinessProfile,
  saveBusinessProfile,
  scoutTools,
  setIntegrationJournal,
  setSpcFetchForTests,
  resetSpcSyncForTests,
  spcCsvUrl,
  spcDayFromKey,
  spcSyncDays,
  spcSyncKey,
  stopBoss,
  syncSpcDay,
  syncStormReportsAllTenants,
  ToolRegistry,
} from "../src/index";
import { integrations } from "../src/events/breaker";
import { resetDb, seedUser } from "../../db/test/helpers";

// Same combined-file shape the live SPC endpoint serves (three headed sections).
const SPC = `Time,F_Scale,Location,County,State,Lat,Lon,Comments
2310,UNK,3 N Plano,Collin,TX,33.06,-96.70,Brief tornado reported by trained spotter. (FWD)
Time,Speed,Location,County,State,Lat,Lon,Comments
2200,65,Mesquite,Dallas,TX,32.77,-96.60,Measured gust. (FWD)
Time,Size,Location,County,State,Lat,Lon,Comments
2105,175,2 W Richardson,Dallas,TX,32.95,-96.76,Golf ball size hail. (FWD)
`;

const HEADERS_ONLY = `Time,F_Scale,Location,County,State,Lat,Lon,Comments
Time,Speed,Location,County,State,Lat,Lon,Comments
Time,Size,Location,County,State,Lat,Lon,Comments
`;

const PROFILE = {
  vertical: "roofing",
  services: ["Roof inspection"],
  idealCustomer: "Homeowners",
  serviceArea: { states: ["TX"], counties: [], center: null },
  settings: { radiusMiles: 10, lookbackDays: 30, minScore: 30 },
};

const stubFetch = (handler: (url: string) => { status: number; body: string }) =>
  (async (url: unknown) => {
    const r = handler(String(url));
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => null },
      text: async () => r.body,
      json: async () => ({}),
    };
  }) as unknown as typeof fetch;

const okCsv = (body: string) => stubFetch(() => ({ status: 200, body }));

describe("SPC report-day math and URLs", () => {
  it("names the report day by its 12:00 UTC start", () => {
    expect(currentSpcReportDay(new Date("2026-11-16T12:00:00Z"))).toBe("2026-11-16");
    expect(currentSpcReportDay(new Date("2026-11-16T17:54:00Z"))).toBe("2026-11-16");
    expect(currentSpcReportDay(new Date("2026-11-17T01:00:00Z"))).toBe("2026-11-16"); // still yesterday's report day
    expect(currentSpcReportDay(new Date("2026-11-16T11:59:00Z"))).toBe("2026-11-15");
    expect(currentSpcReportDay(new Date("2027-01-01T00:30:00Z"))).toBe("2026-12-31");
  });

  it("syncs the current day plus two lookback days, newest first", () => {
    expect(spcSyncDays(new Date("2026-11-16T17:00:00Z"))).toEqual(["2026-11-16", "2026-11-15", "2026-11-14"]);
    expect(spcSyncDays(new Date("2026-01-01T00:00:00Z"))).toEqual(["2025-12-31", "2025-12-30", "2025-12-29"]);
  });

  it("builds the live-verified SPC URL and refuses bad days", () => {
    expect(spcCsvUrl("2026-11-16")).toBe("https://www.spc.noaa.gov/climo/reports/261116_rpts_filtered.csv");
    expect(() => spcCsvUrl("2026-13-40")).toThrow();
    expect(() => spcCsvUrl("garbage")).toThrow();
    expect(spcSyncKey("2026-11-16")).toBe("spc.sync:2026-11-16");
    expect(spcDayFromKey("spc.sync:2026-11-16")).toBe("2026-11-16");
    expect(spcDayFromKey("spc.sync:not-a-day")).toBeNull();
    expect(spcDayFromKey("nws:abc")).toBeNull();
  });
});

describe("storm sync", () => {
  let orgId: string;

  beforeEach(async () => {
    await resetDb();
    await seedUser("owner", "owner@example.test");
    configureEngine({ router: new ModelRouter([new MockModelProvider(() => ({}))], "mock"), tools: new ToolRegistry().register(...scoutTools()) });
    registerIntegrationHandlers();
    resetSpcSyncForTests();
    orgId = (await createOrg({ actorUserId: "owner", name: "Roof Co" })).orgId;
    await operatorSetPlan(orgId, "scout_pro", "test");
  });

  afterEach(() => {
    setIntegrationJournal(undefined);
    resetSpcSyncForTests();
  });

  afterAll(async () => {
    await stopBoss();
    await closePool();
  });

  it("fetches a report day, ingests it once, and audits the system actor", async () => {
    setSpcFetchForTests(okCsv(SPC));
    const first = await syncSpcDay(orgId, "2026-11-16");
    expect(first).toMatchObject({ status: "ingested", added: 3, duplicates: 0 });
    const signals = await listSignals({ actorUserId: "owner", orgId });
    expect(signals).toHaveLength(3);
    // The automatic pass is labelled so it can't be confused with a manual upload.
    const sources = await withTenant(orgId, async (tx) =>
      (await tx.execute(sql`SELECT label, created_by, row_count FROM intelligence_sources`)).rows as { label: string; created_by: string; row_count: number }[]);
    expect(sources).toEqual([{ label: "SPC storm reports 2026-11-16 (auto)", created_by: "storm-sync", row_count: 3 }]);
    const audit = await withTenant(orgId, async (tx) =>
      (await tx.execute(sql`SELECT actor_type, actor_id, outcome FROM audit_events WHERE action = 'scout.signals.sync'`)).rows);
    expect(audit).toEqual([{ actor_type: "system", actor_id: "storm-sync", outcome: "success" }]);
    // Re-syncing the same day (the 6-hourly overlap) is a free no-op.
    const again = await syncSpcDay(orgId, "2026-11-16");
    expect(again).toMatchObject({ status: "ingested", added: 0, duplicates: 3 });
    expect(await listSignals({ actorUserId: "owner", orgId })).toHaveLength(3);
  });

  it("treats 404 and headers-only files as quiet days, never errors", async () => {
    setSpcFetchForTests(stubFetch((url) => (url.includes("261116") ? { status: 404, body: "" } : { status: 200, body: HEADERS_ONLY })));
    expect(await syncSpcDay(orgId, "2026-11-16")).toMatchObject({ status: "no_reports", added: 0 });
    expect(await syncSpcDay(orgId, "2026-11-15")).toMatchObject({ status: "no_reports", added: 0 });
    const sources = await withTenant(orgId, async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM intelligence_sources`)).rows);
    expect((sources[0] as { n: number }).n).toBe(0);
  });

  it("opens the spc breaker after repeated 5xx and short-circuits", async () => {
    setSpcFetchForTests(stubFetch(() => ({ status: 503, body: "" })));
    for (let i = 0; i < 3; i++) await expect(syncSpcDay(orgId, "2026-11-16")).rejects.toThrow(/503/);
    expect(integrations.snapshot().find((s) => s.name === "spc")?.state).toBe("open");
    await expect(syncSpcDay(orgId, "2026-11-16")).rejects.toThrow(/paused|breaker_open/);
  });

  it("never fetches in mock mode without a test override", async () => {
    resetSpcSyncForTests(); // no override; WOS_MOCK_MODE=1 comes from the vitest env
    expect(await syncSpcDay(orgId, "2026-11-16")).toMatchObject({ status: "skipped_mock" });
  });

  it("dead-letters a failed day and the owner replay refetches and ingests it", async () => {
    setIntegrationJournal(activeJournal());
    let calls = 0;
    setSpcFetchForTests((async (_url: unknown) => {
      calls++;
      const ok = calls > 1;
      return {
        ok, status: ok ? 200 : 503,
        headers: { get: () => null },
        text: async () => (ok ? SPC : ""),
        json: async () => ({}),
      };
    }) as unknown as typeof fetch);
    await expect(syncSpcDay(orgId, "2026-11-16")).rejects.toThrow(/503/);
    const open = await listDeadLetters({ actorUserId: "owner", orgId });
    const letter = open.find((row) => row.type === "integration.spc");
    expect(letter).toBeTruthy();
    const result = await replayDeadLetter({ actorUserId: "owner", orgId, deadLetterId: letter!.id });
    expect(result.status).toBe("done");
    expect(calls).toBe(2);
    expect(await listSignals({ actorUserId: "owner", orgId })).toHaveLength(3);
    expect(await listDeadLetters({ actorUserId: "owner", orgId })).toEqual([]);
  });

  it("fans out to eligible orgs only and isolates each org's copy", async () => {
    // Eligible: reviewed profile + scout feature.
    await saveBusinessProfile({ actorUserId: "owner", orgId, profile: PROFILE });
    await reviewBusinessProfile({ actorUserId: "owner", orgId });
    // Ineligible: profile reviewed while on scout_pro, then moved to growth (no scout feature).
    const other = (await createOrg({ actorUserId: "owner", name: "Other Co" })).orgId;
    await operatorSetPlan(other, "scout_pro", "test");
    await saveBusinessProfile({ actorUserId: "owner", orgId: other, profile: PROFILE });
    await reviewBusinessProfile({ actorUserId: "owner", orgId: other });
    await operatorSetPlan(other, "growth", "test");
    // A third org with no profile at all is never listed.
    await createOrg({ actorUserId: "owner", name: "Empty Co" });

    setSpcFetchForTests(stubFetch((url) => (url.includes("261116_rpts") ? { status: 200, body: SPC } : { status: 404, body: "" })));
    const r = await syncStormReportsAllTenants({ now: new Date("2026-11-16T17:00:00Z") });
    expect(r).toMatchObject({ tenants: 1, ingested: 1, noReports: 2, failed: 0 });
    expect(await listSignals({ actorUserId: "owner", orgId })).toHaveLength(3);
    // listSignals enforces the plan feature, so count the other org's rows directly.
    const otherRows = await withTenant(other, async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM signal_observations`)).rows);
    expect((otherRows[0] as { n: number }).n).toBe(0);
  });
});
