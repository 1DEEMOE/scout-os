import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@wos/db";
import {
  createRoutine,
  executeRoutineRun,
  recoverLostRoutineRuns,
  recoverLostRoutinesAsManager,
  recoverLostRoutinesForTenant,
  recoverOneRoutine,
  stopBoss,
  type RoutineRunJob,
} from "../src/index";
import { ownerQuery } from "../../db/test/helpers";
import { auditActions, setupHarness, type Harness } from "./engine-helpers";

afterAll(async () => {
  await stopBoss();
  await closePool();
});

const daily = [0, 1, 2, 3, 4, 5, 6];
const NOW = new Date("2026-11-05T11:00:00Z");
let h: Harness;

async function newRoutine() {
  return createRoutine({
    actorUserId: "owner",
    orgId: h.orgId,
    kind: "morning_briefing",
    name: "Morning briefing",
    hour: 7,
    minute: 0,
    daysOfWeek: daily,
    timezone: "America/New_York",
    now: NOW,
  });
}

function jobFor(r: { id: string; tenantId: string; nextRunAt: Date | null }): RoutineRunJob {
  return { tenantId: r.tenantId, routineId: r.id, scheduledFor: r.nextRunAt!.toISOString(), trigger: "schedule" };
}

async function dropJobs(routineId: string) {
  await ownerQuery(`DELETE FROM pgboss.job WHERE name = 'routine.run' AND data->>'routineId' = $1`, [routineId]);
}

async function jobCount(routineId: string) {
  const rows = await ownerQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'routine.run' AND data->>'routineId' = $1 AND state IN ('created','retry','active')`,
    [routineId],
  );
  return rows[0]!.n;
}

describe("routine-run recovery scanner", () => {
  beforeEach(async () => {
    h = await setupHarness();
  });

  it("re-queues a due routine whose job was lost, exactly once, and audits it", async () => {
    const r = await newRoutine();
    expect(await jobCount(r.id)).toBe(1);
    await dropJobs(r.id);
    expect(await jobCount(r.id)).toBe(0);

    const first = await recoverLostRoutinesForTenant(h.orgId, { now: new Date("2026-11-05T12:05:00Z") });
    expect(first).toMatchObject({ scanned: 1, recovered: 1, skippedDuplicate: 0, errors: 0 });
    expect(await jobCount(r.id)).toBe(1);

    const second = await recoverLostRoutinesForTenant(h.orgId, { now: new Date("2026-11-05T12:06:00Z") });
    // Live job from the first recovery → skippedAlive (UNIQUE would also yield duplicate if job were gone).
    expect(second.recovered).toBe(0);
    expect(second.skippedAlive + second.skippedDuplicate).toBe(1);
    expect(await jobCount(r.id)).toBe(1);

    const audits = await auditActions(h.orgId);
    const recoveries = audits.filter((a) => a.action === "routine.recover");
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.outcome).toBe("success");
    expect(recoveries[0]!.metadata).toMatchObject({ reason: "missing_job" });
    // No PII in audit metadata
    expect(JSON.stringify(recoveries[0]!.metadata)).not.toMatch(/@|account|phone/i);
  });

  it("skips when a live job still exists or the run already completed", async () => {
    const r = await newRoutine();
    const alive = await recoverOneRoutine(
      { id: r.id, tenantId: r.tenantId, nextRunAt: r.nextRunAt! },
      { now: new Date("2026-11-05T12:05:00Z") },
    );
    expect(alive).toBe("alive");

    await executeRoutineRun(jobFor(r), { now: () => new Date("2026-11-05T12:00:05Z") });
    // After success next_run_at advanced — force the old scheduled instant back for the check
    await withTenant(h.orgId, async (tx) => {
      await tx.execute(
        // language=SQL
        (await import("drizzle-orm")).sql`UPDATE routines SET next_run_at = ${r.nextRunAt} WHERE id = ${r.id}`,
      );
    });
    await dropJobs(r.id);
    const already = await recoverOneRoutine(
      { id: r.id, tenantId: r.tenantId, nextRunAt: r.nextRunAt! },
      { now: new Date("2026-11-05T12:10:00Z") },
    );
    expect(already).toBe("already_run");
  });

  it("manager gate: members cannot trigger recoverLost; platform scan uses admin URL", async () => {
    const r = await newRoutine();
    await dropJobs(r.id);
    await expect(
      recoverLostRoutinesAsManager({ actorUserId: "member", orgId: h.orgId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const asOwner = await recoverLostRoutinesAsManager({
      actorUserId: "owner",
      orgId: h.orgId,
      now: new Date("2026-11-05T12:05:00Z"),
    });
    expect(asOwner).toMatchObject({ scanned: 1, recovered: 1 });

    const platform = await recoverLostRoutineRuns({ now: new Date("2026-11-05T12:05:00Z") });
    expect(platform.disabled).toBeUndefined();
    // Already recovered → duplicate skip
    expect(platform.skippedDuplicate + platform.skippedAlive + platform.skippedAlreadyRun).toBeGreaterThanOrEqual(1);
  });
});
