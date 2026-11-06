import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import {
  approveAllTemplates,
  collectSignals,
  createOrg,
  getPack,
  bookVisit,
  dueForRebook,
  ingestLead,
  listTemplates,
  quickstartBusiness,
  setVisitStatus,
  recordSmsConsent,
  resetNwsCache,
  smsWindowOpen,
  speedSummary,
} from "../src/index";
import { fetchNwsAlerts, NWS_USER_AGENT, parseNwsPayload } from "../src/speed/nws";
import { resetDb, seedUser } from "../../db/test/helpers";

let orgId: string;

beforeEach(async () => {
  await resetDb();
  resetNwsCache();
  await seedUser("owner", "owner@example.test");
  await seedUser("other", "other@example.test");
  orgId = (await createOrg({ actorUserId: "owner", name: "Northside Nails" })).orgId;
});

afterAll(async () => {
  await closePool();
});

describe("speed to lead", () => {
  it("stages pack replies for a person to approve, then sends only that wording inside the rules", async () => {
    await quickstartBusiness({ actorUserId: "owner", orgId, name: "Northside Nails", industry: "nail_salon", timezone: "America/Chicago" });
    const staged = await listTemplates({ actorUserId: "owner", orgId });
    expect(staged.length).toBeGreaterThan(0);
    expect(staged.every((t) => t.status === "ready_to_approve")).toBe(true);
    expect(getPack("nail_salon").services.every((s) => s.priceIsExample)).toBe(true);

    const noon = new Date("2026-06-15T17:00:00Z"); // 12:00 in Chicago (CDT)
    const early = new Date("2026-06-15T12:00:00Z"); // 07:00 in Chicago
    expect(smsWindowOpen(noon, "America/Chicago")).toBe(true);
    expect(smsWindowOpen(early, "America/Chicago")).toBe(false);

    const waiting = await ingestLead({ actorUserId: "owner", orgId, source: "sms", externalKey: "lead-1", name: "Ana", phone: "3125550100", timezone: "America/Chicago", now: noon });
    expect(waiting.outcome).toBe("waiting_for_template");

    await approveAllTemplates({ actorUserId: "owner", orgId });
    await recordSmsConsent({ actorUserId: "owner", orgId, phone: "3125550100", evidence: "She checked the text box on the booking form." });

    const quiet = await ingestLead({ actorUserId: "owner", orgId, source: "sms", externalKey: "lead-quiet", name: "Ana", phone: "3125550100", timezone: "America/Chicago", now: early });
    expect(quiet.outcome).toBe("blocked");
    expect(quiet.blockReason).toBe("quiet_hours");

    const sent = await ingestLead({ actorUserId: "owner", orgId, source: "sms", externalKey: "lead-2", name: "Ana", phone: "3125550100", timezone: "America/Chicago", now: noon, businessName: "Northside Nails" });
    expect(sent.outcome).toBe("sent");
    expect(sent.mock).toBe(true);
    expect(Date.parse(sent.firstResponseAt!) - Date.parse(sent.arrivedAt)).toBeLessThanOrEqual(60_000);

    const custom = await ingestLead({ actorUserId: "owner", orgId, source: "sms", externalKey: "lead-3", name: "Ana", phone: "3125550100", timezone: "America/Chicago", now: noon, customBody: "A different sentence that was not approved." });
    expect(custom.outcome).toBe("queued");
    expect(custom.approvalId).toBeTruthy();

    await ingestLead({ actorUserId: "owner", orgId, source: "sms", externalKey: "lead-stop", phone: "3125550199", customBody: "STOP", now: noon });
    const stopped = await ingestLead({ actorUserId: "owner", orgId, source: "sms", externalKey: "lead-4", name: "Ana", phone: "3125550199", timezone: "America/Chicago", now: noon });
    expect(stopped.blockReason === "stop" || stopped.outcome === "blocked").toBe(true);

    const summary = await speedSummary({ actorUserId: "owner", orgId });
    expect(summary.label).toBe("respond-in-60s");
    expect(summary.within60).toBeGreaterThanOrEqual(1);

    const other = (await createOrg({ actorUserId: "other", name: "Other Shop" })).orgId;
    expect((await speedSummary({ actorUserId: "other", orgId: other })).leads).toBe(0);
    await expect(speedSummary({ actorUserId: "other", orgId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("appointment packs", () => {
  it("books a chair without taking payment, rejects a double book, and lists who is due", async () => {
    await quickstartBusiness({ actorUserId: "owner", orgId, name: "Northside Nails", industry: "nail_salon", timezone: "America/Chicago" });
    const start = new Date("2026-05-01T15:00:00Z");
    const first = await bookVisit({ actorUserId: "owner", orgId, serviceId: "fill", resourceId: "chair-1", name: "Ana", phone: "3125550100", startsAt: start });
    expect(first.status).toBe("booked");
    await expect(bookVisit({ actorUserId: "owner", orgId, serviceId: "manicure", resourceId: "chair-1", name: "Bea", startsAt: new Date(start.getTime() + 30 * 60_000) })).rejects.toMatchObject({ code: "CONFLICT" });
    await setVisitStatus({ actorUserId: "owner", orgId, visitId: first.id, status: "completed" });
    const due = await dueForRebook({ actorUserId: "owner", orgId, now: new Date(start.getTime() + 30 * 86_400_000) });
    expect(due.some((d) => d.serviceId === "fill" && d.days >= 18)).toBe(true);
  });
});

describe("signal sources", () => {
  it("keeps weather as one source and labels mock feeds", () => {
    const april = new Date("2026-04-15T15:00:00Z");
    const hvac = collectSignals(getPack("hvac"), { now: april, alerts: [{ id: "nws-1", event: "Severe Thunderstorm Warning", area: "Dallas County, TX", effective: april.toISOString(), headline: "Wind" }] });
    expect(hvac.some((h) => h.source === "seasonal")).toBe(true);
    expect(hvac.some((h) => h.source === "weather" && h.limit.match(/not a damage/i))).toBe(true);
    const nails = collectSignals(getPack("nail_salon"), { now: april, alerts: [{ id: "nws-1", event: "Tornado Warning", area: "Dallas County, TX", effective: april.toISOString(), headline: "Tornado" }] });
    expect(nails.some((h) => h.source === "weather")).toBe(false);
    const moving = collectSignals(getPack("moving"), { now: april });
    expect(moving.every((h) => h.demo && h.title.startsWith("MOCK"))).toBe(true);
  });

  it("sends a User-Agent and caches the public alert feed", async () => {
    const calls: string[] = [];
    const body = { features: [{ id: "https://api.weather.gov/alerts/x", properties: { event: "Severe Thunderstorm Warning", areaDesc: "Dallas County, TX", effective: "2026-06-01T18:00:00Z", headline: "Wind" } }] };
    const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push(init?.headers?.["User-Agent"] ?? "");
      expect(String(url)).toContain("api.weather.gov");
      return { ok: true, json: async () => body } as Response;
    }) as typeof fetch;
    const now = new Date("2026-06-01T18:00:00Z");
    const first = await fetchNwsAlerts({ fetchImpl, now });
    const second = await fetchNwsAlerts({ fetchImpl, now: new Date(now.getTime() + 60_000) });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(calls).toEqual([NWS_USER_AGENT]);
    expect(parseNwsPayload(body)[0]?.event).toMatch(/Thunderstorm/);
  });
});
