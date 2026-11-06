import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@wos/db";
import {
  AppError,
  configureEngine,
  MockModelProvider,
  ModelRouter,
  scoutTools,
  ToolRegistry,
  createOrg,
  eventTime,
  importProspects,
  inviteMember,
  listOpportunities,
  listSignals,
  milesBetween,
  operatorSetPlan,
  parseCsv,
  parseSpcCsv,
  purgeExpiredProspects,
  reportDayFromFilename,
  reviewBusinessProfile,
  runScoutScan,
  saveBusinessProfile,
  scoreMatch,
  stopBoss,
  uploadStormReports,
  vertical,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

async function expectCode(p: Promise<unknown>, code: AppError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
}

// Combined SPC daily file shape: three headed sections. Coordinates near Dallas, TX.
const SPC = `Time,F_Scale,Location,County,State,Lat,Lon,Comments
2310,UNK,3 N Plano,Collin,TX,33.06,-96.70,Brief tornado reported by trained spotter. (FWD)
Time,Speed,Location,County,State,Lat,Lon,Comments
0115,UNK,Garland,Dallas,TX,32.91,-96.64,Trees down, fences damaged. (FWD)
2200,65,Mesquite,Dallas,TX,32.77,-96.60,Measured gust. (FWD)
Time,Size,Location,County,State,Lat,Lon,Comments
2105,175,2 W Richardson,Dallas,TX,32.95,-96.76,Golf ball size hail. (FWD)
2130,100,Irving,Dallas,TX,32.81,-96.95,"Quarter size hail, reported via ""mPING"". (FWD)"
2140,abc,Nowhere,Dallas,TX,32.8,-96.9,bad size
`;

describe("CSV and geography", () => {
  it("parses quotes, doubled quotes, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n\r\n')).toEqual([["a", "b"], ["x, y", 'he said "hi"']]);
  });
  it("measures distance correctly (1 degree of latitude ≈ 69.1 miles)", () => {
    expect(milesBetween({ lat: 32, lon: -96 }, { lat: 33, lon: -96 })).toBeCloseTo(69.09, 1);
    expect(milesBetween({ lat: 32.95, lon: -96.76 }, { lat: 32.95, lon: -96.76 })).toBe(0);
  });
});

describe("SPC parser", () => {
  it("reads the three sections, units and UNK", () => {
    const { signals, rejected } = parseSpcCsv(SPC, "2026-11-01");
    expect(signals.map((s) => s.kind)).toEqual(["tornado", "wind", "wind", "hail", "hail"]);
    const [tornado, windUnk, wind, hail, quarter] = signals;
    expect(tornado).toMatchObject({ magnitude: null, magnitudeUnit: null, county: "Collin", state: "TX", lat: 33.06, lon: -96.7 });
    expect(windUnk).toMatchObject({ magnitude: null, magnitudeUnit: "mph", comments: "Trees down, fences damaged. (FWD)" }); // unquoted commas kept
    expect(wind!.magnitude).toBe(65);
    expect(hail).toMatchObject({ magnitude: 1.75, magnitudeUnit: "in" });
    expect(quarter!.comments).toBe('Quarter size hail, reported via "mPING". (FWD)');
    expect(rejected).toEqual([{ line: 9, reason: 'bad size "abc"' }]);
  });

  it("puts times before 12:00 UTC on the next calendar day", () => {
    expect(eventTime("2026-11-01", "2310")!.toISOString()).toBe("2026-11-01T23:10:00.000Z");
    expect(eventTime("2026-11-01", "0115")!.toISOString()).toBe("2026-11-02T01:15:00.000Z");
    expect(eventTime("2026-11-01", "1159")!.toISOString()).toBe("2026-11-02T11:59:00.000Z");
    expect(eventTime("2026-11-01", "1200")!.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(eventTime("2026-12-31", "0005")!.toISOString()).toBe("2027-01-01T00:05:00.000Z");
    expect(eventTime("2026-11-01", "2460")).toBeNull();
  });

  it("accepts SPC's digit-string coordinates (degrees west) and a single section", () => {
    const { signals } = parseSpcCsv("Time,Size,Location,County,State,Lat,Lon,Comments\n1830,100,Dodge City,Ford,KS,3775,10002,\n", "2026-11-01");
    expect(signals[0]).toMatchObject({ lat: 37.75, lon: -100.02, magnitude: 1 });
  });

  it("reads the report day from SPC file names and refuses nonsense dates", () => {
    expect(reportDayFromFilename("261101_rpts_filtered.csv")).toBe("2026-11-01");
    expect(reportDayFromFilename("261341_rpts.csv")).toBeNull();
    expect(reportDayFromFilename("storms.csv")).toBeNull();
    expect(() => parseSpcCsv(SPC, "2026-02-30")).toThrow();
  });

  it("gives the same row the same reference (so re-uploads dedupe)", () => {
    expect(parseSpcCsv(SPC, "2026-11-01").signals.map((s) => s.externalRef)).toEqual(parseSpcCsv(SPC, "2026-11-01").signals.map((s) => s.externalRef));
  });
});

describe("heuristic score", () => {
  const v = vertical("roofing");
  const now = new Date("2026-11-04T00:00:00Z");
  it("follows the ADR table and the total is the sum of its parts", () => {
    const r = scoreMatch(v, { signal: { kind: "hail", magnitude: 1.75, magnitudeUnit: "in", eventAt: new Date("2026-11-02T00:00:00Z") }, distanceMiles: 2, reliability: "import_with_coordinates", engaged: false, now });
    expect(r.breakdown).toMatchObject({ signalRelevance: { points: 30 }, freshness: { points: 20 }, geographicFit: { points: 20 }, dataReliability: { points: 10 }, verifiedEngagement: { points: 0 } });
    expect(r.score).toBe(80);
    expect(r.score).toBe(Object.values(r.breakdown).reduce((n, f) => n + f.points, 0));
  });
  it("scores every band", () => {
    const at = (d: number) => new Date(now.getTime() - d * 86_400_000);
    const s = (kind: "hail" | "wind" | "tornado", magnitude: number | null, days: number, dist: number | null) =>
      scoreMatch(v, { signal: { kind, magnitude, magnitudeUnit: kind === "hail" ? "in" : "mph", eventAt: at(days) }, distanceMiles: dist, reliability: "import_county_only", engaged: true, now }).breakdown;
    expect(s("hail", 1, 10, 5)).toMatchObject({ signalRelevance: { points: 20 }, freshness: { points: 14 }, geographicFit: { points: 14 }, dataReliability: { points: 5 }, verifiedEngagement: { points: 15 } });
    expect(s("hail", 0.75, 60, null)).toMatchObject({ signalRelevance: { points: 8 }, freshness: { points: 8 }, geographicFit: { points: 8 } });
    expect(s("wind", 80, 100, 12)).toMatchObject({ signalRelevance: { points: 20 }, freshness: { points: 2 }, geographicFit: { points: 6 } });
    expect(s("wind", 60, 1, 1).signalRelevance.points).toBe(12);
    expect(s("wind", null, 1, 1).signalRelevance.points).toBe(6);
    expect(s("tornado", null, 1, 1).signalRelevance.points).toBe(30);
  });
  it("never claims damage", () => {
    const texts = [v.whyRelevant, v.limitations, v.describeSignal({ kind: "hail", magnitude: 2, magnitudeUnit: "in" })];
    for (const t of texts) expect(t).not.toMatch(/\b(damaged roof|roof (is|was) damaged|has damage|needs (a )?(new )?roof)\b/i);
    expect(v.whyRelevant).toMatch(/not evidence/);
  });
});

// ---------- services ----------

let orgId: string;
const NOW = new Date("2026-11-04T00:00:00Z");
const PROFILE = {
  vertical: "roofing",
  services: ["Roof inspection"],
  idealCustomer: "Homeowners",
  serviceArea: { states: [], counties: [{ state: "TX", county: "Dallas County" }], center: null },
  settings: { radiusMiles: 10, lookbackDays: 30, minScore: 30 },
};
const PROSPECTS = `name,email,address,city,county,state,zip,lat,lon,ethnicity,income
Ana Diaz,ana@example.test,1 Elm St,Richardson,Dallas,TX,75080,32.96,-96.74,should-not-store,should-not-store
Ben Ode,,2 Oak St,Mesquite,Dallas,TX,75149,,,x,y
Cy Far,cy@example.test,3 Pine St,Austin,Travis,TX,78701,30.27,-97.74,x,y
,nobody@example.test,4 Ash St,Dallas,Dallas,TX,75201,,,x,y
`;

async function ready() {
  await saveBusinessProfile({ actorUserId: "owner", orgId, profile: PROFILE });
  await reviewBusinessProfile({ actorUserId: "owner", orgId });
  await uploadStormReports({ actorUserId: "owner", orgId, csv: SPC, reportDay: "2026-11-01" });
  return importProspects({ actorUserId: "owner", orgId, csv: PROSPECTS, label: "Past customers", usageRights: "Our own customer list from past jobs.", attest: true });
}
const scan = () => withTenant(orgId, (tx) => runScoutScan(tx, orgId, { type: "user", id: "owner" }, NOW));

beforeEach(async () => {
  await resetDb();
  for (const u of ["owner", "member", "outsider", "other"]) await seedUser(u, `${u}@example.test`);
  configureEngine({ router: new ModelRouter([new MockModelProvider(() => ({}))], "mock"), tools: new ToolRegistry().register(...scoutTools()) });
  orgId = (await createOrg({ actorUserId: "owner", name: "Roof Co" })).orgId;
  await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
  await operatorSetPlan(orgId, "scout_pro", "test");
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("Scout access", () => {
  it("is refused on plans without Scout, and to non-managers for writes, and to outsiders", async () => {
    await operatorSetPlan(orgId, "growth", "test");
    await expectCode(saveBusinessProfile({ actorUserId: "owner", orgId, profile: PROFILE }), "UPGRADE_REQUIRED");
    await expectCode(listOpportunities({ actorUserId: "owner", orgId }), "UPGRADE_REQUIRED");
    await operatorSetPlan(orgId, "scout_pro", "test");
    await expectCode(saveBusinessProfile({ actorUserId: "member", orgId, profile: PROFILE }), "FORBIDDEN");
    await expectCode(importProspects({ actorUserId: "member", orgId, csv: PROSPECTS, label: "x", usageRights: "our own list of customers", attest: true }), "FORBIDDEN");
    await expectCode(listOpportunities({ actorUserId: "outsider", orgId }), "NOT_FOUND");
    await expect(listOpportunities({ actorUserId: "member", orgId })).resolves.toEqual([]);
  });
});

describe("business profile", () => {
  it("must be reviewed by a person before a scan, and editing sends it back to draft", async () => {
    await saveBusinessProfile({ actorUserId: "owner", orgId, profile: PROFILE });
    await expectCode(scan(), "CONFLICT");
    expect((await reviewBusinessProfile({ actorUserId: "owner", orgId })).status).toBe("reviewed");
    const again = await saveBusinessProfile({ actorUserId: "owner", orgId, profile: { ...PROFILE, services: ["Roof repair"] } });
    expect(again).toMatchObject({ status: "draft", reviewedBy: null });
    await expectCode(scan(), "CONFLICT");
  });
  it("validates input", async () => {
    await expectCode(saveBusinessProfile({ actorUserId: "owner", orgId, profile: { ...PROFILE, serviceArea: { states: [], counties: [], center: null } } }), "VALIDATION");
    await expectCode(saveBusinessProfile({ actorUserId: "owner", orgId, profile: { ...PROFILE, vertical: "plumbing" } }), "VALIDATION");
  });
});

describe("storm report upload", () => {
  it("stores provenance and dedupes a re-upload", async () => {
    const first = await uploadStormReports({ actorUserId: "owner", orgId, csv: SPC, filename: "261101_rpts_filtered.csv" });
    expect(first).toMatchObject({ reportDay: "2026-11-01", added: 5, duplicates: 0 });
    expect(first.rejected).toHaveLength(1);
    expect(await uploadStormReports({ actorUserId: "owner", orgId, csv: SPC, reportDay: "2026-11-01" })).toMatchObject({ added: 0, duplicates: 5 });
    const signals = await listSignals({ actorUserId: "member", orgId, kind: "hail" });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({ confidence: expect.stringMatching(/Preliminary/), limitations: expect.stringMatching(/not that any property was damaged/) });
  });
  it("asks for the day when the file name doesn't carry it", async () => {
    await expectCode(uploadStormReports({ actorUserId: "owner", orgId, csv: SPC, filename: "storms.csv" }), "VALIDATION");
  });
});

describe("prospect import", () => {
  it("requires an attestation and a description of usage rights", async () => {
    await expectCode(importProspects({ actorUserId: "owner", orgId, csv: PROSPECTS, label: "x", usageRights: "our own list of customers", attest: false }), "VALIDATION");
    await expectCode(importProspects({ actorUserId: "owner", orgId, csv: PROSPECTS, label: "x", usageRights: "list", attest: true }), "VALIDATION");
  });
  it("stores only allow-listed columns, reports what it dropped, and dedupes", async () => {
    const r = await importProspects({ actorUserId: "owner", orgId, csv: PROSPECTS, label: "Past customers", usageRights: "Our own customer list from past jobs.", attest: true });
    expect(r).toMatchObject({ added: 3, duplicates: 0, droppedColumns: ["ethnicity", "income"], rejected: [{ line: 5, reason: "no name" }] });
    const cols = await withTenant(orgId, async (tx) => (await tx.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'prospects'`)).rows.map((x) => (x as { column_name: string }).column_name));
    expect(cols).not.toContain("ethnicity");
    const src = await withTenant(orgId, async (tx) => (await tx.execute(sql`SELECT kind, attested_by, usage_rights FROM intelligence_sources`)).rows);
    expect(src).toEqual([{ kind: "customer_import", attested_by: "owner", usage_rights: "Our own customer list from past jobs." }]);
    expect(await importProspects({ actorUserId: "owner", orgId, csv: PROSPECTS, label: "again", usageRights: "Our own customer list from past jobs.", attest: true })).toMatchObject({ added: 0, duplicates: 3 });
  });
  it("counts rows against the plan and refuses the whole file when it doesn't fit", async () => {
    process.env.SCOUT_PLAN_CATALOG = JSON.stringify([
      { id: "starter", label: "Starter", features: ["core_agents"], limits: { seats: 5, tasks: 50, "scout.opportunities": 0, "scout.prospect_rows": 0 } },
      { id: "scout_pro", label: "Scout Pro", features: ["core_agents", "scout"], limits: { seats: 5, tasks: 50, "scout.opportunities": 10, "scout.prospect_rows": 2 } },
    ]);
    const { resetPlanCatalogCache } = await import("../src/index");
    resetPlanCatalogCache();
    try {
      await expectCode(importProspects({ actorUserId: "owner", orgId, csv: PROSPECTS, label: "x", usageRights: "Our own customer list from past jobs.", attest: true }), "QUOTA_EXCEEDED");
      const n = await withTenant(orgId, async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM prospects`)).rows[0] as { n: number });
      expect(n.n).toBe(0);
    } finally {
      delete process.env.SCOUT_PLAN_CATALOG;
      resetPlanCatalogCache();
    }
  });
  it("does not count DEMO prospect rows against the import quota", async () => {
    process.env.SCOUT_PLAN_CATALOG = JSON.stringify([
      { id: "starter", label: "Starter", features: ["core_agents"], limits: { seats: 5, tasks: 50, "scout.opportunities": 0, "scout.prospect_rows": 0 } },
      { id: "scout_pro", label: "Scout Pro", features: ["core_agents", "scout"], limits: { seats: 5, tasks: 50, "scout.opportunities": 10, "scout.prospect_rows": 2 } },
    ]);
    const { resetPlanCatalogCache } = await import("../src/index");
    resetPlanCatalogCache();
    try {
      // Three DEMO rows would exceed the limit of 2 if they counted.
      const demo = await importProspects({
        actorUserId: "owner", orgId, csv: PROSPECTS, label: "Sample homeowners",
        usageRights: "Invented sample records for trying Scout. Not real people.",
        attest: true, demo: true,
      });
      expect(demo.added).toBe(3);
      const used = await withTenant(orgId, async (tx) =>
        (await tx.execute(sql`SELECT used FROM usage_counters WHERE metric = 'scout.prospect_rows'`)).rows);
      expect(used).toEqual([]);
      // A real (non-demo) import of three NEW rows still hits the quota of 2.
      // Different names/emails so they are not deduped against the DEMO set.
      const realCsv = `name,email,address,city,county,state,zip,lat,lon
Carol Real,carol@example.test,10 Maple,Dallas,Dallas,TX,75201,32.78,-96.80
Dave Real,dave@example.test,11 Birch,Plano,Collin,TX,75023,33.02,-96.70
Eve Real,eve@example.test,12 Cedar,Garland,Dallas,TX,75040,32.91,-96.64
`;
      await expectCode(
        importProspects({ actorUserId: "owner", orgId, csv: realCsv, label: "Real list", usageRights: "Our own customer list from past jobs.", attest: true }),
        "QUOTA_EXCEEDED",
      );
      const after = await withTenant(orgId, async (tx) =>
        (await tx.execute(sql`SELECT count(*)::int AS n FROM prospects WHERE demo = false`)).rows[0] as { n: number });
      expect(after.n).toBe(0);
    } finally {
      delete process.env.SCOUT_PLAN_CATALOG;
      resetPlanCatalogCache();
    }
  });
    it("imports 5,000 prospect rows without hitting Postgres bind-parameter limits", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => `Person ${i},Dallas,TX,32.95,-96.75`);
    const csv = `name,county,state,lat,lon\n${rows.join("\n")}\n`;
    const r = await importProspects({
      actorUserId: "owner",
      orgId,
      csv,
      label: "Full Scout Pro month",
      usageRights: "Our own customer list from past jobs, uploaded for a capacity check.",
      attest: true,
    });
    expect(r).toMatchObject({ added: 5000, duplicates: 0 });
    const n = await withTenant(orgId, async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM prospects`)).rows[0] as { n: number });
    expect(n.n).toBe(5000);
  });
});

describe("scan", () => {
  it("matches by distance and by county, explains every opportunity and stays inside the service area", async () => {
    await ready();
    const r = await scan();
    expect(r).toMatchObject({ examined: 2, created: 2, updated: 0, stoppedByQuota: false }); // Travis County is outside the area
    const opps = await listOpportunities({ actorUserId: "member", orgId });
    expect(opps.map((o) => o.prospect.name)).toEqual(["Ana Diaz", "Ben Ode"]);
    const [ana, ben] = opps;
    expect(ana).toMatchObject({ stage: "prospect" });
    // Ana: 1.75 in. hail ~1.1 mi away, 2 days before NOW, attested import with coordinates, no engagement.
    expect(ana!.scoreBreakdown).toMatchObject({ signalRelevance: { points: 30 }, freshness: { points: 20 }, geographicFit: { points: 20 }, dataReliability: { points: 10 }, verifiedEngagement: { points: 0 } });
    expect(ana!.score).toBe(80);
    // Ben has no coordinates: county match only.
    expect(ben!.scoreBreakdown).toMatchObject({ geographicFit: { points: 8 }, dataReliability: { points: 5 } });
    for (const o of opps) {
      const e = o.explanation as Record<string, unknown>;
      for (const k of ["whyIdentified", "whyRelevant", "evidence", "missingInformation", "recommendedAction", "confidenceBasis"]) expect(e[k], k).toBeTruthy();
      expect(e.confidenceBasis).toMatch(/not a probability/);
      expect(e.recommendedAction).toMatch(/Don't contact yet/);
      expect(e.missingInformation).toContain(o.prospect.email ? "No recorded permission to contact them." : "No email address.");
      expect(JSON.stringify(e)).not.toMatch(/warm lead|roof (is|was) damaged/i);
      expect(o.score).toBe(Object.values(o.scoreBreakdown as Record<string, { points: number }>).reduce((n, f) => n + f.points, 0));
    }
  });

  it("updates on a re-scan instead of duplicating, and never resurfaces someone a person ruled out", async () => {
    await ready();
    await scan();
    expect(await scan()).toMatchObject({ created: 0, updated: 2 });
    await withTenant(orgId, (tx) => tx.execute(sql`UPDATE opportunities SET stage = 'disqualified', disqualified_reason = 'renter' WHERE prospect_id IN (SELECT id FROM prospects WHERE name = 'Ben Ode')`));
    expect(await scan()).toMatchObject({ created: 0, updated: 1 });
  });

  it("stops creating new opportunities at the monthly allowance", async () => {
    process.env.SCOUT_PLAN_CATALOG = JSON.stringify([
      { id: "starter", label: "Starter", features: ["core_agents"], limits: { seats: 5, tasks: 50, "scout.opportunities": 0, "scout.prospect_rows": 0 } },
      { id: "scout_pro", label: "Scout Pro", features: ["core_agents", "scout"], limits: { seats: 5, tasks: 50, "scout.opportunities": 1, "scout.prospect_rows": 100 } },
    ]);
    const { resetPlanCatalogCache } = await import("../src/index");
    resetPlanCatalogCache();
    try {
      await ready();
      expect(await scan()).toMatchObject({ created: 1, stoppedByQuota: true });
    } finally {
      delete process.env.SCOUT_PLAN_CATALOG;
      resetPlanCatalogCache();
    }
  });

  it("ignores reports older than the lookback window", async () => {
    await ready();
    const later = await withTenant(orgId, (tx) => runScoutScan(tx, orgId, { type: "user", id: "owner" }, new Date("2026-12-15T00:00:00Z")));
    expect(later.created).toBe(0);
  });

  it("recommends a follow-up only with recorded permission, and never for suppressed addresses", async () => {
    await ready();
    await withTenant(orgId, (tx) => tx.execute(sql`INSERT INTO communication_permissions (tenant_id, channel, value, basis, evidence, recorded_by) VALUES (${orgId}, 'email', 'ana@example.test', 'inbound_inquiry', 'She emailed us on Nov 3', 'owner')`));
    await scan();
    const ana = (await listOpportunities({ actorUserId: "owner", orgId })).find((o) => o.prospect.name === "Ana Diaz")!;
    expect((ana.explanation as { recommendedAction: string }).recommendedAction).toMatch(/Follow up by email/);
    expect((ana.scoreBreakdown as { verifiedEngagement: { points: number } }).verifiedEngagement.points).toBe(15);
    await withTenant(orgId, (tx) => tx.execute(sql`INSERT INTO suppression_list (tenant_id, channel, value, reason, added_by) VALUES (${orgId}, 'email', 'ana@example.test', 'opt_out', 'owner')`));
    await scan();
    const again = (await listOpportunities({ actorUserId: "owner", orgId })).find((o) => o.prospect.name === "Ana Diaz")!;
    expect((again.explanation as { recommendedAction: string }).recommendedAction).toMatch(/do-not-contact/);
  });
});

describe("retention", () => {
  it("deletes expired prospects not worked by a person, keeps worked ones, and audits the count", async () => {
    await ready();
    await scan();
    await withTenant(orgId, (tx) => tx.execute(sql`UPDATE opportunities SET stage = 'engaged' WHERE prospect_id IN (SELECT id FROM prospects WHERE name = 'Ana Diaz')`));
    const deleted = await withTenant(orgId, (tx) => purgeExpiredProspects(tx, orgId, new Date(Date.now() + 400 * 86_400_000)));
    expect(deleted).toBe(2); // Ben (prospect stage) and Cy (no opportunity)
    const left = await withTenant(orgId, async (tx) => (await tx.execute(sql`SELECT name FROM prospects`)).rows);
    expect(left).toEqual([{ name: "Ana Diaz" }]);
    const audit = await withTenant(orgId, async (tx) => (await tx.execute(sql`SELECT metadata FROM audit_events WHERE action = 'scout.prospects.purge'`)).rows);
    expect(audit).toEqual([{ metadata: { deleted: 2 } }]);
  });
});

describe("tenant isolation", () => {
  it("another org sees none of this org's Scout data", async () => {
    await ready();
    await scan();
    const other = (await createOrg({ actorUserId: "other", name: "Other Roofing" })).orgId;
    await operatorSetPlan(other, "scout_pro", "test");
    expect(await listOpportunities({ actorUserId: "other", orgId: other })).toEqual([]);
    expect(await listSignals({ actorUserId: "other", orgId: other })).toEqual([]);
    await expectCode(listOpportunities({ actorUserId: "other", orgId }), "NOT_FOUND");
  });
});
