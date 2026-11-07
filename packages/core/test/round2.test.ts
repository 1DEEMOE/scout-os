import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import { bookVisit, chooseIndustry, createOrg, handoffReliability, readPilotMetrics, setVisitStatus } from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

beforeEach(async () => {
  await resetDb();
  await seedUser("owner", "owner@example.test");
});
afterAll(async () => {
  await closePool();
});

describe("round 2 pilot and handoffs", () => {
  it("times setup from the industry choice and counts a rebooked miss", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Pilot Co" });
    await chooseIndustry({ actorUserId: "owner", orgId, industry: "yoga_studio" });
    const started = await readPilotMetrics({ actorUserId: "owner", orgId });
    expect(started.setupStartedAt).toBeTruthy();
    expect(started.setupSeconds).toBeNull();
    expect(started.bookingsRecovered).toBe(0);
    expect(started.hoursSavedMinutes).toBe(0);
    expect(started.mock).toBe(true);
    const visit = await bookVisit({
      actorUserId: "owner",
      orgId,
      serviceId: "dropin",
      resourceId: "mat-1",
      name: "Ada",
      startsAt: new Date(Date.now() + 86_400_000),
    });
    await setVisitStatus({ actorUserId: "owner", orgId, visitId: visit.id, status: "no_show" });
    expect((await readPilotMetrics({ actorUserId: "owner", orgId })).bookingsRecovered).toBe(0);
    await setVisitStatus({ actorUserId: "owner", orgId, visitId: visit.id, status: "booked" });
    expect((await readPilotMetrics({ actorUserId: "owner", orgId })).bookingsRecovered).toBe(1);
  });

  it("shows calendar, CRM, and accounting as not connected until a handoff fails", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Handoff Co" });
    const lanes = await handoffReliability({ actorUserId: "owner", orgId });
    expect(lanes.map((l) => l.lane)).toEqual(["calendar", "crm", "accounting"]);
    expect(lanes.every((l) => l.state === "not_connected" && l.openFailures === 0)).toBe(true);
  });
});
