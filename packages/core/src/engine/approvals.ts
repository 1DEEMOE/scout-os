import { and, desc, eq, lt, sql } from "drizzle-orm";
import { approvalRequests, isUuid, organizationMembers, tasks, type ApprovalStatus, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { ANY_ROLE, auditDenied, inOrg, MANAGERS, requireRole } from "../org/access";
import { isOwnerOnly, ownerOnlyReason } from "./owner-only";
import { enqueueTaskRun } from "./queue";
import { assertPaymentCallbackVerified, markPaymentChangeRejected } from "../finance/payment-guard";
import { FRONT_DESK_TOOL, rejectFrontDeskBooking } from "../front-desk/service";

export type ApprovalRow = typeof approvalRequests.$inferSelect;

export async function listApprovals(input: { actorUserId: string; orgId: string; status?: ApprovalStatus }): Promise<ApprovalRow[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "approval.list");
    await expireDue(tx, input.orgId);
    const q = tx.select().from(approvalRequests);
    return (input.status ? q.where(eq(approvalRequests.status, input.status)) : q).orderBy(desc(approvalRequests.requestedAt)).limit(200);
  });
}

/** Marks pending requests past their expiry as expired, and wakes their tasks. */
export async function expireDue(tx: Tx, tenantId: string): Promise<number> {
  const rows = await tx
    .update(approvalRequests)
    .set({ status: "expired" })
    .where(and(eq(approvalRequests.tenantId, tenantId), sql`${approvalRequests.status} IN ('pending', 'awaiting_confirmation')`, lt(approvalRequests.expiresAt, new Date())))
    .returning({ id: approvalRequests.id, taskId: approvalRequests.taskId });
  for (const r of rows) {
    await recordAudit(tx, { tenantId, actorType: "system", actorId: "approvals", action: "approval.expire", target: `approval:${r.id}`, tier: 0, outcome: "success" });
    await enqueueTaskRun(tx, { tenantId, taskId: r.taskId });
  }
  return rows.length;
}

async function loadForDecision(tx: Tx, orgId: string, approvalId: string): Promise<ApprovalRow> {
  const [row] = isUuid(approvalId)
    ? await tx.select().from(approvalRequests).where(eq(approvalRequests.id, approvalId)).for("update")
    : [];
  if (!row) throw new AppError("NOT_FOUND", "Approval request not found");
  if (row.expiresAt.getTime() <= Date.now() && (row.status === "pending" || row.status === "awaiting_confirmation")) {
    await expireDue(tx, orgId);
    throw new AppError("CONFLICT", "This request has expired. The task will not run this action.");
  }
  return row;
}

/**
 * A human approves or rejects one exact action. Owners and admins only.
 * Tier 4 actions need a separate confirmation step afterwards (confirmApproval).
 */
export async function decideApproval(input: { actorUserId: string; orgId: string; approvalId: string; decision: "approve" | "reject" }): Promise<{ status: ApprovalStatus }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "approval.decide");
    const row = await loadForDecision(tx, input.orgId, input.approvalId);
    if (row.status !== "pending") throw new AppError("CONFLICT", `This request is already ${row.status.replace("_", " ")}`);

    // Some holds are owner-only (bank-detail changes, possibly forged invoices, first outreach).
    const ownerOnly = isOwnerOnly(row.toolName);
    if (ownerOnly) {
      const [me] = await tx.select({ role: organizationMembers.role }).from(organizationMembers).where(eq(organizationMembers.userId, input.actorUserId));
      if (me?.role !== "owner") {
        await auditDenied(input.orgId, input.actorUserId, input.decision === "reject" ? "approval.reject" : "approval.approve", { approvalId: row.id, reason: "owner_only", tool: row.toolName });
        throw new AppError("FORBIDDEN", ownerOnlyReason(row.toolName));
      }
    }

    // No self-approval: the person who asked for the work can't be the human
    // check on it, unless they are the only manager (solo org), which is audited.
    let selfApprovalWaiver = false;
    if (input.decision === "approve") {
      const [task] = await tx.select({ requestedBy: tasks.requestedBy }).from(tasks).where(eq(tasks.id, row.taskId));
      if (task?.requestedBy === input.actorUserId) {
        const managers = await tx
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(ownerOnly ? sql`${organizationMembers.role} = 'owner'` : sql`${organizationMembers.role} IN ('owner', 'admin')`);
        if (managers.some((m) => m.userId !== input.actorUserId)) {
          await auditDenied(input.orgId, input.actorUserId, "approval.approve", { approvalId: row.id, reason: "self_approval" });
          throw new AppError("FORBIDDEN", ownerOnly ? "You asked for this action, so another owner has to approve it" : "You asked for this action, so another owner or admin has to approve it");
        }
        selfApprovalWaiver = true;
      }
    }

    if (input.decision === "approve") {
      await assertPaymentCallbackVerified(tx, row.id, row.toolName);
    }
    const status: ApprovalStatus = input.decision === "reject" ? "rejected" : row.tier === 4 ? "awaiting_confirmation" : "approved";
    await tx
      .update(approvalRequests)
      .set({ status, decidedBy: input.actorUserId, decidedAt: new Date() })
      .where(and(eq(approvalRequests.id, row.id), eq(approvalRequests.status, "pending")));
    if (input.decision === "reject") {
      await markPaymentChangeRejected(tx, row.id);
      if (row.toolName === FRONT_DESK_TOOL) {
        const bookingId = (row.payload as { args?: { bookingId?: string } })?.args?.bookingId;
        if (bookingId) await rejectFrontDeskBooking(tx, input.orgId, bookingId);
      }
    }
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: input.decision === "reject" ? "approval.reject" : "approval.approve",
      target: `approval:${row.id}`,
      approvalRequestId: row.id,
      tier: row.tier as 2 | 3 | 4,
      outcome: "success",
      metadata: { tool: row.toolName, digest: row.actionDigest, taskId: row.taskId, ...(selfApprovalWaiver ? { selfApprovalWaiver: "sole_manager" } : {}) },
    });
    if (status !== "awaiting_confirmation") await wakeTask(tx, input.orgId, row.taskId);
    return { status };
  });
}

/** Second, separate confirmation for tier 4 (destructive or privileged) actions. Owners only. */
export async function confirmApproval(input: { actorUserId: string; orgId: string; approvalId: string }): Promise<{ status: ApprovalStatus }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ["owner"], "approval.confirm");
    const row = await loadForDecision(tx, input.orgId, input.approvalId);
    if (row.tier !== 4 || row.status !== "awaiting_confirmation") {
      await auditDenied(input.orgId, input.actorUserId, "approval.confirm", { approvalId: row.id, status: row.status });
      throw new AppError("CONFLICT", "This request isn't waiting for a confirmation");
    }
    if (row.decidedBy === input.actorUserId) {
      await auditDenied(input.orgId, input.actorUserId, "approval.confirm", { approvalId: row.id, reason: "same_person" });
      throw new AppError("FORBIDDEN", "The second confirmation has to come from a different owner");
    }
    await tx
      .update(approvalRequests)
      .set({ status: "approved", confirmedBy: input.actorUserId, confirmedAt: new Date() })
      .where(and(eq(approvalRequests.id, row.id), eq(approvalRequests.status, "awaiting_confirmation")));
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "approval.confirm",
      target: `approval:${row.id}`,
      approvalRequestId: row.id,
      tier: 4,
      outcome: "success",
      metadata: { tool: row.toolName, digest: row.actionDigest, taskId: row.taskId },
    });
    await wakeTask(tx, input.orgId, row.taskId);
    return { status: "approved" };
  });
}

async function wakeTask(tx: Tx, tenantId: string, taskId: string): Promise<void> {
  const [t] = await tx.select({ state: tasks.state }).from(tasks).where(eq(tasks.id, taskId));
  if (t?.state === "WAITING_FOR_APPROVAL") await enqueueTaskRun(tx, { tenantId, taskId });
}
