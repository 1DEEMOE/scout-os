import { and, desc, eq, gt, sql } from "drizzle-orm";
import { approvalRequests, usageEvents, withTenant, workflowExecutions } from "@wos/db";
import { recordAudit } from "../audit";
import { logger } from "../logger";
import { withSpan } from "../tracing";
import { actionDigest } from "./digest";
import { getEngine } from "./runtime";
import { scrubPii } from "../logger";
import { beforeToolCall, checkToolOutput } from "./tool-guard";
import { logOp } from "../events/correlation";
import { ToolError, type Tier, type ToolContext } from "./tools";

export interface PlanStep {
  index: number;
  tool: string;
  args: unknown;
  tier: Tier;
  summary: string;
  digest: string;
  decision: "allow" | "needs_approval";
  approvalId?: string;
  /** Argument paths whose values came from external data (forced to tier 2+). */
  tainted?: string[];
}

export interface Plan {
  steps: PlanStep[];
  note: string;
  model: { provider: string; model: string; mock: boolean };
}

/**
 * Runs one planned step, at most once in effect.
 *
 * 1. In a transaction: skip if the step already succeeded; for tier 2+,
 *    re-hash the action and consume its approval (single use, unexpired, same
 *    digest); record a "running" attempt.
 * 2. Outside any transaction: call the tool. If any earlier attempt exists
 *    (crashed, or failed with an unknown outcome such as a dropped connection),
 *    ask the tool to reconcile by idempotency key before calling it again.
 * 3. In a transaction: record the output and the audit entry.
 */
async function recordStepSkipped(tx: Parameters<typeof recordAudit>[0], tenantId: string, taskId: string, agentId: string, step: PlanStep) {
  await recordAudit(tx, {
    tenantId,
    actorType: "system",
    actorId: agentId,
    action: "task.step.skipped",
    target: `task:${taskId}`,
    tier: 0,
    outcome: "success",
    metadata: { reason: "already_completed", step: step.index, tool: step.tool },
  });
}

/** Another run already owns this approved step. Not a failure. */
export class StepAlreadyDone extends Error {
  readonly code = "ALREADY_COMPLETED";
  constructor() {
    super("This step was already completed by another run");
    this.name = "StepAlreadyDone";
  }
}

export async function executeStep(task: { id: string; tenantId: string; assignedAgentId: string | null; input?: Record<string, unknown> }, step: PlanStep): Promise<unknown> {
  const { tools } = getEngine();
  const tool = tools.get(step.tool);
  if (!tool) throw new ToolError(`Tool ${step.tool} is no longer registered`, false, "UNKNOWN_TOOL");
  const agentId = task.assignedAgentId!;
  const stepName = `${step.index}:${step.tool}`;
  const key = `${task.id}:${step.index}:${step.digest}`;
  const ctx: ToolContext = { tenantId: task.tenantId, taskId: task.id, agentId, idempotencyKey: key };

  // The digest stored in the plan must still describe exactly these arguments.
  const recomputed = actionDigest({ tenantId: task.tenantId, taskId: task.id, agentId, step: step.index, tool: step.tool, args: step.args, chainId: delegationOf(task.input)?.chainId });
  if (recomputed !== step.digest) throw new ToolError("Planned action no longer matches its digest", false, "DIGEST_MISMATCH");

  const claim = await withTenant(task.tenantId, async (tx) => {
    let prior = await tx
      .select()
      .from(workflowExecutions)
      .where(and(eq(workflowExecutions.taskId, task.id), eq(workflowExecutions.step, stepName)))
      .orderBy(desc(workflowExecutions.attempt));
    const done = prior.find((p) => p.status === "succeeded");
    if (done) return { kind: "done" as const, output: done.output };

    if (step.decision === "needs_approval") {
      if (!step.approvalId) throw new ToolError("Step needs approval but has none", false, "NO_APPROVAL");
      const [ap] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, step.approvalId)).for("update");
      if (!ap || ap.taskId !== task.id || ap.actionDigest !== recomputed) {
        throw new ToolError("Approval does not match this exact action", false, "APPROVAL_MISMATCH");
      }
      if (ap.status === "approved") {
        const used = await tx
          .update(approvalRequests)
          .set({ status: "consumed", consumedAt: new Date() })
          .where(and(eq(approvalRequests.id, ap.id), eq(approvalRequests.status, "approved"), sql`${approvalRequests.consumedAt} IS NULL`, gt(approvalRequests.expiresAt, new Date())))
          .returning({ id: approvalRequests.id });
        if (!used.length) throw new ToolError("Approval expired before it could be used", false, "APPROVAL_EXPIRED");
        await recordAudit(tx, { tenantId: task.tenantId, actorType: "system", actorId: "executor", action: "approval.consume", target: `approval:${ap.id}`, approvalRequestId: ap.id, tier: ap.tier as Tier, outcome: "success" });
      } else if (ap.status === "consumed") {
        // `prior` was read before this transaction waited on the approval row, so a
        // concurrent winner can have committed its execution while we were blocked.
        prior = await tx
          .select()
          .from(workflowExecutions)
          .where(and(eq(workflowExecutions.taskId, task.id), eq(workflowExecutions.step, stepName)))
          .orderBy(desc(workflowExecutions.attempt));
        const succeeded = prior.find((p) => p.status === "succeeded");
        if (succeeded) {
          await recordStepSkipped(tx, task.tenantId, task.id, agentId, step);
          return { kind: "done" as const, output: succeeded.output };
        }
        if (prior.some((p) => p.status === "running")) {
          await recordStepSkipped(tx, task.tenantId, task.id, agentId, step);
          return { kind: "skipped" as const };
        }
        // Consumed with no execution is a replay, not a race. Failed attempts fall
        // through so a dropped send can reconcile.
        if (prior.length === 0) throw new ToolError(`Approval is ${ap.status}, not approved`, false, "APPROVAL_NOT_USABLE");
      } else {
        throw new ToolError(`Approval is ${ap.status}, not approved`, false, "APPROVAL_NOT_USABLE");
      }
    }

    const interrupted = prior.find((p) => p.status === "running");
    if (interrupted) {
      await tx.update(workflowExecutions).set({ status: "failed", error: "interrupted", finishedAt: new Date() }).where(eq(workflowExecutions.id, interrupted.id));
    }
    const attempt = (prior[0]?.attempt ?? 0) + 1;
    const [row] = await tx
      .insert(workflowExecutions)
      .values({ tenantId: task.tenantId, taskId: task.id, step: stepName, attempt, status: "running", idempotencyKey: key })
      .returning({ id: workflowExecutions.id });
    return { kind: "run" as const, rowId: row!.id, hadPriorAttempt: prior.length > 0 };
  });

  if (claim.kind === "done") return claim.output;
  if (claim.kind === "skipped") throw new StepAlreadyDone();

  let output: unknown;
  let reconciled = false;
  const started = Date.now();
  try {
    output = await withSpan("tool.execute", { tool: step.tool, "task.id": task.id, "agent.id": agentId }, async () => {
      beforeToolCall(tool, ctx);
      if (claim.hadPriorAttempt && tool.reconcile) {
        const earlier = await tool.reconcile(ctx, step.args);
        if (earlier !== undefined) {
          reconciled = true;
          return earlier;
        }
      }
      return tool.execute(ctx, step.args);
    });
    output = checkToolOutput(tool, output);
  } catch (err) {
    const message = String(scrubPii(err instanceof Error ? err.message : String(err)) ?? "error");
    await withTenant(task.tenantId, async (tx) => {
      await tx.update(workflowExecutions).set({ status: "failed", error: message.slice(0, 2000), finishedAt: new Date() }).where(eq(workflowExecutions.id, claim.rowId));
      await recordAudit(tx, { tenantId: task.tenantId, actorType: "agent", actorId: agentId, action: `tool.${step.tool}`, target: `task:${task.id}`, tier: step.tier, outcome: "error", metadata: { step: step.index, error: message.slice(0, 500) } });
    });
    logger.warn({ tenantId: task.tenantId, taskId: task.id, tool: step.tool, err: message }, "tool failed");
    logOp({ message: "tool failed", tenantId: task.tenantId, agentId, tool: step.tool, input: step.digest, outcome: "error", failure: message, durationMs: Date.now() - started, recovery: err instanceof ToolError && err.retryable ? "retry" : "stop" });
    throw err;
  }
  logOp({ message: "tool finished", tenantId: task.tenantId, agentId, tool: step.tool, input: step.digest, outcome: "success", output: reconciled ? "reconciled" : "ok", durationMs: Date.now() - started });

  await withTenant(task.tenantId, async (tx) => {
    await tx.update(workflowExecutions).set({ status: "succeeded", output: output ?? null, finishedAt: new Date() }).where(eq(workflowExecutions.id, claim.rowId));
    await tx
      .insert(usageEvents)
      .values({ tenantId: task.tenantId, taskId: task.id, agentId, kind: "tool_call", quantity: 1, costMicros: 0, purpose: step.tool, idempotencyKey: `tool:${key}` })
      .onConflictDoNothing();
    await recordAudit(tx, {
      tenantId: task.tenantId,
      actorType: "agent",
      actorId: agentId,
      action: `tool.${step.tool}`,
      target: `task:${task.id}`,
      tier: step.tier,
      outcome: "success",
      idempotencyKey: `exec:${key}`,
      approvalRequestId: step.approvalId,
      metadata: { step: step.index, reconciled },
    });
  });
  return output;
}

export interface Delegation {
  chainId: string;
  depth: number;
  threadId: string;
}

/** The lead bot delegation a task carries, if any (set only by server code). */
export function delegationOf(input: Record<string, unknown> | undefined): Delegation | undefined {
  const d = input?.delegation as Partial<Delegation> | undefined;
  return d && typeof d.chainId === "string" && typeof d.depth === "number" && typeof d.threadId === "string" ? (d as Delegation) : undefined;
}
