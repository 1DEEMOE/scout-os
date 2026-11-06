import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, routineRuns, withTenant } from "@wos/db";
import { createRoutine, executeRoutineRun, runRoutineNow, startRoutineWorker, stopBoss, stopRoutineWorker } from "../src/index";
import { setupHarness, type Harness } from "./engine-helpers";

// Real pg-boss queue and a real routine worker loop in this process.
let h: Harness;

beforeAll(async () => {
  await startRoutineWorker(async (job) => void (await executeRoutineRun(job)), { pollingIntervalSeconds: 0.5 });
});
beforeEach(async () => {
  h = await setupHarness();
});
afterAll(async () => {
  await stopRoutineWorker();
  await stopBoss();
  await closePool();
});

describe("routine worker", () => {
  it("picks up Run now from the queue and stores one briefing, even if the request is sent twice", async () => {
    const r = await createRoutine({ actorUserId: "owner", orgId: h.orgId, kind: "morning_briefing", name: "Briefing", hour: 7, minute: 0, daysOfWeek: [1, 2, 3, 4, 5], timezone: "America/New_York" });
    await runRoutineNow({ actorUserId: "admin", orgId: h.orgId, routineId: r.id, clientRef: "ref-0123456789" });
    await runRoutineNow({ actorUserId: "admin", orgId: h.orgId, routineId: r.id, clientRef: "ref-0123456789" });
    const start = Date.now();
    let runs: (typeof routineRuns.$inferSelect)[];
    while (Date.now() - start < 20000) {
      runs = await withTenant(h.orgId, (tx) => tx.select().from(routineRuns));
      if (runs.some((x) => x.status === "succeeded")) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    await new Promise((res) => setTimeout(res, 1500));
    runs = await withTenant(h.orgId, (tx) => tx.select().from(routineRuns));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", trigger: "manual", idempotencyKey: "manual:ref-0123456789" });
  });
});
