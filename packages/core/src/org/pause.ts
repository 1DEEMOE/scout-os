import { eq, inArray } from "drizzle-orm";
import { organizations, tasks, users, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { logger } from "../logger";
import { enqueueTaskRun } from "../engine/queue";
import { ANY_ROLE, inOrg, requireRole } from "./access";

export interface PauseState {
  paused: boolean;
  pausedAt: Date | null;
  pausedByName: string | null;
}

/** Inside a tenant transaction: is the org's agent kill switch on? */
export async function agentsPaused(tx: Tx, tenantId: string): Promise<boolean> {
  const [o] = await tx.select({ at: organizations.agentsPausedAt }).from(organizations).where(eq(organizations.id, tenantId));
  return !!o?.at;
}

export async function getPauseState(input: { actorUserId: string; orgId: string }): Promise<PauseState> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "agents.pause.read");
    const [o] = await tx
      .select({ at: organizations.agentsPausedAt, by: organizations.agentsPausedBy, name: users.name })
      .from(organizations)
      .leftJoin(users, eq(users.id, organizations.agentsPausedBy))
      .where(eq(organizations.id, input.orgId));
    return { paused: !!o?.at, pausedAt: o?.at ?? null, pausedByName: o?.at ? (o.name ?? "an owner") : null };
  });
}

/** States a paused task may be sitting in that need a nudge when work resumes. */
const RESUMABLE = ["REQUESTED", "CLASSIFIED", "PLANNED", "POLICY_CHECKED", "WAITING_FOR_APPROVAL", "ASSIGNED", "EXECUTING", "RETRY_SCHEDULED"] as const;

/**
 * The kill switch. While on, the engine takes no step on any task and the lead
 * bot hands nothing off; approvals can still be decided. Owners only, because
 * it changes what the business's agents may do (tier 4, privileged).
 */
export async function setAgentsPaused(input: { actorUserId: string; orgId: string; paused: boolean }): Promise<PauseState & { resumedTasks: number }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ["owner"], input.paused ? "agents.pause" : "agents.resume");
    const was = await agentsPaused(tx, input.orgId);
    if (was === input.paused) throw new AppError("CONFLICT", input.paused ? "Agents are already paused" : "Agents aren't paused");
    await tx
      .update(organizations)
      .set(input.paused ? { agentsPausedAt: new Date(), agentsPausedBy: input.actorUserId } : { agentsPausedAt: null, agentsPausedBy: null })
      .where(eq(organizations.id, input.orgId));
    let resumedTasks = 0;
    if (!input.paused) {
      // Wake everything that stopped while paused. Running a task twice is safe (versioned transitions, keyed steps).
      const waiting = await tx.select({ id: tasks.id, state: tasks.state }).from(tasks).where(inArray(tasks.state, [...RESUMABLE]));
      for (const t of waiting) await enqueueTaskRun(tx, { tenantId: input.orgId, taskId: t.id, ...(t.state === "RETRY_SCHEDULED" ? { retry: true } : {}) });
      resumedTasks = waiting.length;
    }
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: input.paused ? "agents.pause" : "agents.resume",
      target: `organization:${input.orgId}`,
      tier: 4,
      outcome: "success",
      metadata: input.paused ? {} : { resumedTasks },
    });
    logger.warn({ tenantId: input.orgId, actor: input.actorUserId, paused: input.paused, resumedTasks }, input.paused ? "agents paused" : "agents resumed");
    const [me] = await tx.select({ name: users.name }).from(users).where(eq(users.id, input.actorUserId));
    return { paused: input.paused, pausedAt: input.paused ? new Date() : null, pausedByName: input.paused ? (me?.name ?? null) : null, resumedTasks };
  });
}
