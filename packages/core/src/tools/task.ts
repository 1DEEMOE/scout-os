import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { tasks, withTenant } from "@wos/db";
import { continuationOf } from "../engine/executor";
import { insertTask } from "../engine/tasks";
import { ToolError, type ToolDefinition, type ToolRegistry } from "../engine/tools";

/**
 * task.continue: an agent hands off a follow-up task, carrying forward a short
 * handoff note (what it learned or produced). The follow-up is a brand-new
 * task: the full classify → plan → policy → approval pipeline runs again, so
 * nothing the first task was allowed to do leaks into the second.
 *
 * Chains are bounded three ways so a confused or poisoned agent cannot queue
 * work forever: depth (follow-ups of follow-ups), fan-out (follow-ups per
 * task), and total tasks per chain. The per-tenant tool rate limit applies on
 * top. Continuation metadata lives under the reserved `continuation` input
 * key, which stripReserved removes from anything a caller sends.
 */

/** How many generations of follow-up may follow a user-created task. */
export const MAX_CONTINUATION_DEPTH = 2;
/** Follow-ups one task may queue. */
export const MAX_CONTINUATIONS_PER_TASK = 3;
/** Total tasks in one chain, counting the original task. */
export const MAX_TASKS_PER_CHAIN = 8;

const argsSchema = z.object({
  intent: z.string().trim().min(1).max(2000),
  summary: z.string().trim().min(1).max(1500),
});

export function taskContinueTools(): ToolDefinition[] {
  const cont: ToolDefinition<z.infer<typeof argsSchema>, { taskId: string; queued: true }> = {
    name: "task.continue",
    description:
      "Queue a follow-up task that continues this one, carrying a short handoff note. The follow-up plans and asks for approvals from scratch. " +
      `Limited to ${MAX_CONTINUATION_DEPTH} follow-ups deep, ${MAX_CONTINUATIONS_PER_TASK} follow-ups per task, ${MAX_TASKS_PER_CHAIN} tasks per chain.`,
    tier: 1,
    args: argsSchema,
    output: z.object({ taskId: z.string(), queued: z.literal(true) }),
    rate: { limit: 6, windowMs: 60 * 60 * 1000 },
    summarize: (a) => `Queue a follow-up task: ${a.intent.slice(0, 120)}`,
    async execute(ctx, a) {
      return withTenant(ctx.tenantId, async (tx) => {
        const [current] = await tx.select().from(tasks).where(eq(tasks.id, ctx.taskId));
        if (!current) throw new ToolError("Current task not found", false, "NOT_FOUND");

        const prior = continuationOf(current.input);
        const depth = (prior?.depth ?? 0) + 1;
        const chainId = prior?.chainId ?? current.id;
        if (depth > MAX_CONTINUATION_DEPTH) {
          throw new ToolError(`Follow-up limit reached (${MAX_CONTINUATION_DEPTH} deep). Ask a person to start a new request if more work is needed.`, false, "CHAIN_DEPTH_LIMIT");
        }

        const [siblingRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(tasks)
          .where(and(eq(tasks.tenantId, ctx.tenantId), eq(tasks.parentTaskId, ctx.taskId)));
        if ((siblingRow?.count ?? 0) >= MAX_CONTINUATIONS_PER_TASK) {
          throw new ToolError(`This task already queued ${MAX_CONTINUATIONS_PER_TASK} follow-ups. Ask a person to start a new request if more are needed.`, false, "CHAIN_FANOUT_LIMIT");
        }

        const [chainRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(tasks)
          .where(and(eq(tasks.tenantId, ctx.tenantId), sql`(${tasks.id} = ${chainId} OR ${tasks.input}->'continuation'->>'chainId' = ${chainId})`));
        if ((chainRow?.count ?? 0) >= MAX_TASKS_PER_CHAIN) {
          throw new ToolError(`This chain of follow-ups reached its limit of ${MAX_TASKS_PER_CHAIN} tasks. Ask a person to start a new request.`, false, "CHAIN_SIZE_LIMIT");
        }

        const continuation = { chainId, depth, fromTaskId: ctx.taskId, summary: a.summary };
        const { taskId } = await insertTask(tx, {
          orgId: ctx.tenantId,
          // The chain stays attributed to the person who started it, not the agent.
          actorUserId: current.requestedBy,
          intent: a.intent,
          title: `Follow-up: ${a.intent}`,
          input: { continuation },
          parentTaskId: ctx.taskId,
          auditMetadata: { via: "task.continue", fromTaskId: ctx.taskId, chainId, depth, agentId: ctx.agentId },
        });
        return { taskId, queued: true as const };
      });
    },
  };
  return [cont] as ToolDefinition[];
}

export function registerTaskContinueTools(registry: ToolRegistry): void {
  registry.register(...taskContinueTools());
}
