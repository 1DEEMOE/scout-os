import { randomUUID } from "node:crypto";
import { createRoutine, executeRoutineRun } from "@wos/core";

/**
 * Creates a Morning Briefing routine and runs it once through the real
 * routine executor, so the briefing on Today is generated from the seeded
 * records (not hand-written). Seeds and demos only.
 */
export async function seedMorningBriefing(input: { actorUserId: string; orgId: string; timezone: string }) {
  const routine = await createRoutine({
    actorUserId: input.actorUserId,
    orgId: input.orgId,
    kind: "morning_briefing",
    name: "Morning briefing",
    hour: 7,
    minute: 0,
    daysOfWeek: [1, 2, 3, 4, 5],
    timezone: input.timezone,
  });
  const outcome = await executeRoutineRun({
    tenantId: input.orgId,
    routineId: routine.id,
    scheduledFor: new Date().toISOString(),
    trigger: "manual",
    clientRef: `seed-${randomUUID()}`,
  });
  if (outcome.status !== "succeeded") {
    throw new Error(`seeded briefing did not complete: ${JSON.stringify(outcome)}`);
  }
  return routine.id;
}
