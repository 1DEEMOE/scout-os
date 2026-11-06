import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { approvalRequests, isUuid, tasks, workflowExecutions, type TaskState, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { ANY_ROLE, auditDenied, inOrg, MANAGERS, requireRole, STAFF } from "../org/access";
import { enqueueTaskRun } from "./queue";
import { consumeQuota } from "../billing/plans";

export type TaskRow = typeof tasks.$inferSelect;

/** Every legal move of the task state machine (docs/design/architecture-v1.md §4). */
export const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  REQUESTED: ["CLASSIFIED", "FAILED"],
  CLASSIFIED: ["PLANNED", "ESCALATED", "FAILED"],
  PLANNED: ["POLICY_CHECKED", "FAILED"],
  POLICY_CHECKED: ["ASSIGNED", "WAITING_FOR_APPROVAL", "FAILED"],
  WAITING_FOR_APPROVAL: ["ASSIGNED", "FAILED"],
  ASSIGNED: ["EXECUTING", "FAILED"],
  EXECUTING: ["VERIFYING", "RETRY_SCHEDULED", "COMPENSATING", "FAILED", "ESCALATED"],
  RETRY_SCHEDULED: ["EXECUTING", "ESCALATED", "FAILED"],
  VERIFYING: ["COMPLETED", "ESCALATED", "FAILED"],
  ESCALATED: ["ASSIGNED", "FAILED"],
  COMPENSATING: ["FAILED"],
  COMPLETED: [],
  FAILED: [],
};

export const TERMINAL: readonly TaskState[] = ["COMPLETED", "FAILED"];

export class IllegalTransitionError extends Error {
  constructor(from: TaskState, to: TaskState) {
    super(`illegal task transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

/** Another worker moved the task first. The caller should re-read and decide again. */
export class TransitionConflictError extends Error {
  constructor(taskId: string) {
    super(`task ${taskId} changed concurrently`);
    this.name = "TransitionConflictError";
  }
}

type Patch = Partial<Pick<TaskRow, "plan" | "result" | "error" | "assignedAgentId" | "attempts">>;

/**
 * The only way a task changes state. Checks the move is legal, applies it only
 * if nobody else changed the task since it was read (version check), and
 * writes the audit entry in the same transaction.
 */
export async function transition(tx: Tx, task: Pick<TaskRow, "id" | "tenantId" | "state" | "version">, to: TaskState, patch: Patch = {}): Promise<TaskRow> {
  if (!TRANSITIONS[task.state].includes(to)) throw new IllegalTransitionError(task.state, to);
  const [row] = await tx
    .update(tasks)
    .set({ ...patch, state: to, version: task.version + 1, updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), eq(tasks.state, task.state), eq(tasks.version, task.version)))
    .returning();
  if (!row) throw new TransitionConflictError(task.id);
  await recordAudit(tx, {
    tenantId: task.tenantId,
    actorType: "system",
    actorId: "orchestrator",
    action: "task.transition",
    target: `task:${task.id}`,
    tier: 0,
    outcome: "success",
    metadata: { from: task.state, to, ...(patch.error ? { error: patch.error } : {}) },
  });
  return row;
}

const createSchema = z.object({
  intent: z.string().trim().min(1, "Describe what you need").max(2000, "Keep the request under 2,000 characters"),
  input: z.record(z.string(), z.unknown()).default({}),
});

/**
 * `direct` is for server code only (never exposed through the API): a fixed
 * list of actions that skips the model's planning step. Direct actions still
 * go through policy and approvals exactly like planned ones.
 */
/** Per-user task creation cap, so a runaway script can't flood the queue. */
export const TASK_CREATE_LIMIT_PER_HOUR = 30;

async function checkCreateRateLimit(tx: Tx, orgId: string, actorUserId: string): Promise<void> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.tenantId, orgId), eq(tasks.requestedBy, actorUserId), gt(tasks.createdAt, new Date(Date.now() - 60 * 60 * 1000))));
  if ((row?.count ?? 0) >= TASK_CREATE_LIMIT_PER_HOUR) {
    throw new AppError("RATE_LIMITED", `You've created ${TASK_CREATE_LIMIT_PER_HOUR} tasks in the last hour. Wait a bit before creating more.`);
  }
}

export async function createTask(input: {
  actorUserId: string;
  orgId: string;
  intent: string;
  /** Short label for people. Defaults to the intent. */
  title?: string;
  input?: Record<string, unknown>;
  direct?: { agentKind: string; steps: { tool: string; args: unknown }[] };
}): Promise<{ taskId: string }> {
  const parsed = createSchema.safeParse({ intent: input.intent, input: input.input ?? {} });
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid task");
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "task.create");
    await checkCreateRateLimit(tx, input.orgId, input.actorUserId);
    return insertTask(tx, {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      intent: parsed.data.intent,
      title: input.title,
      input: stripReserved(input.direct ? { ...parsed.data.input, agentKind: input.direct.agentKind } : parsed.data.input),
      plan: input.direct ? { direct: input.direct.steps } : null,
    });
  });
}

function cleanTitle(title: string | undefined): string | null {
  const t = title?.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 200) : null;
}

/** What people see as the task's name: its title, or the start of the instruction. */
export function taskLabel(t: Pick<TaskRow, "title" | "intent">): string {
  return t.title ?? (t.intent.length > 140 ? `${t.intent.slice(0, 137)}…` : t.intent);
}

/**
 * A completed task whose plan had no actions. Shown as "done, no actions
 * taken" so nobody reads "completed" as "the reminders went out" (Law 2).
 */
export function finishedWithoutActions(t: Pick<TaskRow, "state" | "plan">): boolean {
  if (t.state !== "COMPLETED") return false;
  const steps = (t.plan as { steps?: unknown[] } | null)?.steps;
  return !steps || steps.length === 0;
}

/** `delegation` is set only by the lead bot (server code); callers can't supply it. */
function stripReserved(i: Record<string, unknown>): Record<string, unknown> {
  const { delegation: _d, ...rest } = i;
  return rest;
}

/**
 * Inserts a task, audits it and enqueues its run inside the caller's
 * transaction. The caller must already have checked the actor's role.
 * Used by createTask and by the lead bot's delegations.
 */
export async function insertTask(
  tx: Tx,
  t: { orgId: string; actorUserId: string; intent: string; title?: string; input: Record<string, unknown>; plan?: unknown; auditMetadata?: Record<string, unknown> },
): Promise<{ taskId: string }> {
  await consumeQuota(tx, t.orgId, "tasks", 1);
  const [row] = await tx
    .insert(tasks)
    .values({ tenantId: t.orgId, requestedBy: t.actorUserId, intent: t.intent, title: cleanTitle(t.title), input: t.input, plan: t.plan ?? null })
    .returning({ id: tasks.id });
  await recordAudit(tx, {
    tenantId: t.orgId,
    actorType: "user",
    actorId: t.actorUserId,
    action: "task.create",
    target: `task:${row!.id}`,
    tier: 1,
    outcome: "success",
    ...(t.auditMetadata ? { metadata: t.auditMetadata } : {}),
  });
  await enqueueTaskRun(tx, { tenantId: t.orgId, taskId: row!.id });
  return { taskId: row!.id };
}

export async function listTasks(input: { actorUserId: string; orgId: string; limit?: number }): Promise<TaskRow[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "task.list");
    return tx.select().from(tasks).orderBy(desc(tasks.createdAt)).limit(Math.min(input.limit ?? 50, 200));
  });
}

export async function getTask(input: { actorUserId: string; orgId: string; taskId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "task.get");
    const [task] = isUuid(input.taskId) ? await tx.select().from(tasks).where(eq(tasks.id, input.taskId)) : [];
    if (!task) throw new AppError("NOT_FOUND", "Task not found");
    const steps = await tx.select().from(workflowExecutions).where(eq(workflowExecutions.taskId, task.id)).orderBy(workflowExecutions.startedAt);
    const approvals = await tx.select().from(approvalRequests).where(eq(approvalRequests.taskId, task.id)).orderBy(approvalRequests.requestedAt);
    return { task, steps, approvals };
  });
}

/**
 * Puts an escalated task back to work: a manager has looked at why it stopped
 * (retries exhausted, failed check) and wants another try. Steps that already
 * succeeded are skipped; approvals already used are not asked for again, and
 * nothing that needed approval can run without one.
 */
export async function retryEscalatedTask(input: { actorUserId: string; orgId: string; taskId: string }): Promise<{ state: TaskState }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "task.retry");
    const [task] = isUuid(input.taskId) ? await tx.select().from(tasks).where(eq(tasks.id, input.taskId)) : [];
    if (!task) throw new AppError("NOT_FOUND", "Task not found");
    if (task.state !== "ESCALATED") throw new AppError("CONFLICT", `Only escalated tasks can be retried; this one is ${task.state.replaceAll("_", " ").toLowerCase()}`);
    const steps = (task.plan as { steps?: unknown[] } | null)?.steps;
    if (!steps?.length) throw new AppError("CONFLICT", "This task stopped before it had a plan, so there's nothing to retry. Create a new request instead.");
    const moved = await transition(tx, task, "ASSIGNED", { attempts: 0, error: null });
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "task.retry", target: `task:${task.id}`, tier: 1, outcome: "success", metadata: { previousError: task.error } });
    await enqueueTaskRun(tx, { tenantId: input.orgId, taskId: task.id });
    return { state: moved.state };
  });
}

/**
 * Stops a task that hasn't finished yet. The requester can cancel their own
 * task; owners and admins can cancel anyone's. Pending approvals for the task
 * are expired so nobody approves work that will never run. A queued or
 * in-flight run notices the terminal state and stops without side effects
 * (runTask returns immediately on terminal tasks; steps are idempotent).
 */
export async function cancelTask(input: { actorUserId: string; orgId: string; taskId: string }): Promise<{ state: TaskState }> {
  return inOrg(input.orgId, async (tx) => {
    const actorRole = await requireRole(tx, input.orgId, input.actorUserId, STAFF, "task.cancel");
    const [task] = isUuid(input.taskId) ? await tx.select().from(tasks).where(eq(tasks.id, input.taskId)) : [];
    if (!task) throw new AppError("NOT_FOUND", "Task not found");
    if (TERMINAL.includes(task.state)) throw new AppError("CONFLICT", `This task is already ${task.state.toLowerCase()}`);
    if (task.requestedBy !== input.actorUserId && !MANAGERS.includes(actorRole)) {
      await auditDenied(input.orgId, input.actorUserId, "task.cancel", { taskId: task.id, reason: "not_requester" });
      throw new AppError("FORBIDDEN", "Only the requester or a manager can cancel a task");
    }

    const moved = await transition(tx, task, "FAILED", { error: { message: "Cancelled by a person", code: "CANCELLED" } });
    const orphaned = await tx
      .update(approvalRequests)
      .set({ status: "expired" })
      .where(and(eq(approvalRequests.taskId, task.id), sql`${approvalRequests.status} IN ('pending', 'awaiting_confirmation')`))
      .returning({ id: approvalRequests.id });
    for (const ap of orphaned) {
      await recordAudit(tx, { tenantId: input.orgId, actorType: "system", actorId: "approvals", action: "approval.expire", target: `approval:${ap.id}`, tier: 0, outcome: "success", metadata: { reason: "task_cancelled" } });
    }
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "task.cancel",
      target: `task:${task.id}`,
      tier: 1,
      outcome: "success",
      metadata: { previousState: task.state, expiredApprovals: orphaned.length },
    });
    return { state: moved.state };
  });
}
