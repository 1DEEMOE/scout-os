import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import {
  configureEngine,
  createOrg,
  fetchSpcDay,
  filterSpcCsvToStates,
  importProspects,
  inviteMember,
  listOpportunities,
  MockModelProvider,
  ModelRouter,
  operatorSetPlan,
  quickstartBusiness,
  runOpportunityFinder,
  scoutTools,
  setSpcFetchForTests,
  spcCsvUrl,
  stopBoss,
  StormFeedError,
  ToolRegistry,
} from "../src/index";
import { adminQuery, resetDb, seedUser } from "../../db/test/helpers";

/**
 * A test fixture written in SPC's filtered-report layout (sections with
 * "Time,F_Scale|Speed|Size,Location,County,State,Lat,Lon,Comments" headers,
 * UTC times, hail in hundredths of an inch). The rows are made up for the test.
 */
const DAY_FILE = [
  "Time,F_Scale,Location,County,State,Lat,Lon,Comments",
  "2215,UNK,3 SW Somewhere,Example,OK,35.40,-97.60,Brief touchdown. (OUN)",
  "Time,Speed,Location,County,State,Lat,Lon,Comments",
  "2140,UNK,Atlanta,Fulton,GA,33.76,-84.39,Large limbs down. (FFC)",
  "Time,Size,Location,County,State,Lat,Lon,Comments",
  "2110,175,2 N Atlanta,Fulton,GA,33.78,-84.39,\"Golf ball hail, lasted 5 minutes. (FFC)\"",
  "2125,100,Norman,Cleveland,OK,35.22,-97.44,Quarter size hail. (OUN)",
].join("\n");

const NOW = new Date("2026-11-08T18:00:00Z");
let calls: string[] = [];
const respond = (status: number, body = "", type = "text/csv") => ({ ok: status >= 200 && status < 300, status, headers: { get: (n: string) => (n === "content-type" ? type : null) }, text: async () => body });

let orgId: string;
afterAll(async () => {
  await stopBoss();
  await closePool();
});
afterEach(() => {
  delete process.env.WOS_STORM_FEED;
  setSpcFetchForTests(null);
});

describe("NOAA SPC adapter", () => {
  it("builds the filtered-report URL for an SPC report day", () => {
    expect(spcCsvUrl("2026-11-07")).toBe("https://www.spc.noaa.gov/climo/reports/261107_rpts_filtered.csv");
  });

  it("keeps only the workspace's states, with their section headers", () => {
    const r = filterSpcCsvToStates(DAY_FILE, new Set(["GA"]));
    expect(r.rows).toBe(2);
    expect(r.csv.split("\n")).toEqual([
      "Time,Speed,Location,County,State,Lat,Lon,Comments",
      "2140,UNK,Atlanta,Fulton,GA,33.76,-84.39,Large limbs down. (FFC)",
      "Time,Size,Location,County,State,Lat,Lon,Comments",
      "2110,175,2 N Atlanta,Fulton,GA,33.78,-84.39,\"Golf ball hail, lasted 5 minutes. (FFC)\"",
    ]);
    expect(filterSpcCsvToStates(DAY_FILE, new Set(["TX"])).rows).toBe(0);
  });

  it("treats a missing day as no reports, and refuses anything that isn't a sane SPC file", async () => {
    setSpcFetchForTests(async () => respond(404));
    expect(await fetchSpcDay("2026-11-07")).toBe("");
    setSpcFetchForTests(async () => respond(503));
    await expect(fetchSpcDay("2026-11-07")).rejects.toThrow(StormFeedError);
    setSpcFetchForTests(async () => respond(200, "<html>oops</html>", "text/html"));
    await expect(fetchSpcDay("2026-11-07")).rejects.toThrow(/weren't CSV/);
    setSpcFetchForTests(async () => respond(200, "hello,world"));
    await expect(fetchSpcDay("2026-11-07")).rejects.toThrow(/didn't look like an SPC file/);
    setSpcFetchForTests(async () => respond(200, "x".repeat(2 * 1024 * 1024 + 1)));
    await expect(fetchSpcDay("2026-11-07")).rejects.toThrow(/larger than expected/);
    setSpcFetchForTests(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchSpcDay("2026-11-07")).rejects.toThrow(/Couldn't reach NOAA/);
  });
});

describe("finder with live storm reports (WOS_STORM_FEED=noaa)", () => {
  beforeEach(async () => {
    await resetDb();
    for (const u of ["owner", "member"]) await seedUser(u, `${u}@example.test`);
    configureEngine({ router: new ModelRouter([new MockModelProvider(() => ({ toolCalls: [] }))], "mock"), tools: new ToolRegistry().register(...scoutTools()), retryBaseSeconds: 1 });
    orgId = (await createOrg({ actorUserId: "owner", name: "Peachtree Roofing" })).orgId;
    await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
    await operatorSetPlan(orgId, "scout_pro", "test");
    await quickstartBusiness({ actorUserId: "owner", orgId, name: "Peachtree Roofing", industry: "roofing", timezone: "America/New_York", zip: "30303" });
    // A real customer the shop imported, a mile from the hail report.
    await importProspects({ actorUserId: "owner", orgId, csv: "name,address,city,county,state,zip,lat,lon\nDana Field,12 Peachtree St,Atlanta,Fulton,GA,30303,33.765,-84.388", label: "Our customers", usageRights: "Our own past customers from invoices.", attest: true });
    calls = [];
    process.env.WOS_STORM_FEED = "noaa";
  });

  it("stores real reports for the shop's states only, scores real customers, and never mixes in MOCK permits", async () => {
    setSpcFetchForTests(async (url) => {
      calls.push(url);
      return url.endsWith("261107_rpts_filtered.csv") ? respond(200, DAY_FILE) : respond(404);
    });
    const r = await runOpportunityFinder({ actorUserId: "owner", orgId, now: NOW });
    expect(calls).toEqual(["261107", "261106", "261105"].map((d) => `https://www.spc.noaa.gov/climo/reports/${d}_rpts_filtered.csv`));
    expect(r.sources[0]).toMatchObject({ id: "noaa-spc-filtered", mock: false, records: 4, used: 2 });
    expect(r.sources[1]).toMatchObject({ label: "Building permits (not connected)", used: 0 });
    expect(r.prospectsAdded).toBe(0);
    const signals = await adminQuery<{ state: string; demo: boolean; confidence: string }>("SELECT state, demo, confidence FROM signal_observations WHERE tenant_id = $1", [orgId]);
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.state === "GA" && !s.demo && /Preliminary NOAA SPC/.test(s.confidence))).toBe(true);
    const opps = await listOpportunities({ actorUserId: "owner", orgId });
    expect(opps.map((o) => [o.prospect.name, o.demo])).toEqual([["Dana Field", false]]);
    expect(await adminQuery("SELECT id FROM prospects WHERE tenant_id = $1 AND demo", [orgId])).toEqual([]);
    // Running again adds nothing new.
    await runOpportunityFinder({ actorUserId: "owner", orgId, now: NOW });
    expect((await adminQuery("SELECT id FROM signal_observations WHERE tenant_id = $1", [orgId])).length).toBe(2);
  });

  it("if NOAA can't be reached at all, nothing changes and the owner is told plainly", async () => {
    setSpcFetchForTests(async () => respond(503));
    await expect(runOpportunityFinder({ actorUserId: "owner", orgId, now: NOW })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/answered 503.*Nothing was changed/) });
    expect(await adminQuery("SELECT id FROM signal_observations WHERE tenant_id = $1", [orgId])).toEqual([]);
  });

  it("a member can't make the server call out at all", async () => {
    setSpcFetchForTests(async (url) => {
      calls.push(url);
      return respond(404);
    });
    await expect(runOpportunityFinder({ actorUserId: "member", orgId, now: NOW })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls).toEqual([]);
  });
});
