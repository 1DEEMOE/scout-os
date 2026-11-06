import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  communicationPermissions,
  opportunities,
  opportunityEvents,
  outreachEvents,
  prospects,
  suppressionList,
  tasks,
  PERMISSION_BASES,
  SUPPRESSION_REASONS,
  type OpportunityStage,
  type Tx,
} from "@wos/db";
import { recordAudit } from "../audit";
import { requireFeature } from "../billing/plans";
import { insertTask } from "../engine/tasks";
import { AppError } from "../errors";
import { inOrg, MANAGERS, requireRole, STAFF } from "../org/access";
import { normalizeAddress } from "./consent";
import { vertical } from "./verticals";

type User = { actorUserId: string; orgId: string };
type Actor = { type: "user" | "agent" | "system"; id: string };

/**
 * Lifecycle (ADR-004 §5): prospect → engaged → qualified → opportunity.
 * Stages can't be skipped; disqualify is allowed from any open stage. Every
 * move records who, when and the evidence.
 */
const NEXT: Record<OpportunityStage, OpportunityStage[]> = {
  prospect: ["engaged", "disqualified"],
  engaged: ["qualified", "disqualified"],
  qualified: ["opportunity", "disqualified"],
  opportunity: ["disqualified"],
  disqualified: [],
};

export function canMove(from: OpportunityStage, to: OpportunityStage): boolean {
  return NEXT[from].includes(to);
}

async function access(tx: Tx, input: User, roles: readonly ("owner" | "admin" | "member" | "viewer")[], action: string) {
  await requireRole(tx, input.orgId, input.actorUserId, roles, action);
  await requireFeature(tx, input.orgId, "scout", { type: "user", id: input.actorUserId }, action);
}

async function loadOpp(tx: Tx, id: string) {
  if (!z.uuid().safeParse(id).success) throw new AppError("NOT_FOUND", "Opportunity not found");
  const [row] = await tx.select({ o: opportunities, p: prospects }).from(opportunities)
    .innerJoin(prospects, and(eq(prospects.tenantId, opportunities.tenantId), eq(prospects.id, opportunities.prospectId)))
    .where(eq(opportunities.id, id));
  if (!row) throw new AppError("NOT_FOUND", "Opportunity not found");
  return row;
}

/** Moves a stage after checking the transition; writes the event and the audit row. */
export async function moveStage(tx: Tx, tenantId: string, oppId: string, from: OpportunityStage, to: OpportunityStage, actor: Actor, evidence: string, extra: Partial<typeof opportunities.$inferInsert> = {}) {
  if (!canMove(from, to)) throw new AppError("CONFLICT", `Can't move from ${from} to ${to}. Stages can't be skipped.`);
  // Optimistic check: only moves if nobody changed the stage meanwhile.
  const r = await tx.update(opportunities).set({ ...extra, stage: to, updatedAt: new Date() }).where(and(eq(opportunities.id, oppId), eq(opportunities.stage, from))).returning({ id: opportunities.id });
  if (!r.length) throw new AppError("CONFLICT", "This opportunity changed while you were looking at it. Reload and try again.");
  await tx.insert(opportunityEvents).values({ tenantId, opportunityId: oppId, fromStage: from, toStage: to, actorType: actor.type, actorId: actor.id, evidence: evidence.slice(0, 2000) });
  await recordAudit(tx, { tenantId, actorType: actor.type, actorId: actor.id, action: "scout.stage", target: `opportunity:${oppId}`, tier: 1, outcome: "success", metadata: { from, to } });
}

const evidenceText = z.string().trim().min(5, "Say what happened (at least 5 characters).").max(2000);

/** A person records an interaction (call, visit, reply). */
export async function markEngaged(input: User & { opportunityId: string; evidence: string }) {
  return inOrg(input.orgId, async (tx) => {
    await access(tx, input, STAFF, "scout.engage");
    const ev = evidenceText.safeParse(input.evidence);
    if (!ev.success) throw new AppError("VALIDATION", ev.error.issues[0]!.message);
    const { o } = await loadOpp(tx, input.opportunityId);
    await moveStage(tx, input.orgId, o.id, o.stage, "engaged", { type: "user", id: input.actorUserId }, ev.data);
  });
}

/** Engaged + every qualification question answered by a person. */
export async function qualifyOpportunity(input: User & { opportunityId: string; answers: Record<string, unknown>; note?: string }) {
  return inOrg(input.orgId, async (tx) => {
    await access(tx, input, STAFF, "scout.qualify");
    const { o } = await loadOpp(tx, input.opportunityId);
    const v = vertical(o.vertical);
    const answers: Record<string, string> = {};
    for (const q of v.qualification) {
      const a = input.answers[q.id];
      const val = typeof a === "string" ? a.trim().slice(0, 500) : typeof a === "boolean" ? (a ? "yes" : "no") : "";
      if (!val) throw new AppError("VALIDATION", `Answer: ${q.question}`);
      answers[q.id] = val;
    }
    const note = (input.note ?? "").trim().slice(0, 1000);
    const qualification = { answers, note, answeredBy: input.actorUserId, answeredAt: new Date().toISOString() };
    await moveStage(tx, input.orgId, o.id, o.stage, "qualified", { type: "user", id: input.actorUserId },
      `Qualification answered: ${v.qualification.map((q) => `${q.question} ${answers[q.id]}`).join(" ")}${note ? ` Note: ${note}` : ""}`, { qualification });
  });
}

export async function disqualifyOpportunity(input: User & { opportunityId: string; reason: string }) {
  return inOrg(input.orgId, async (tx) => {
    await access(tx, input, STAFF, "scout.disqualify");
    const reason = z.string().trim().min(3, "Give a reason.").max(500).safeParse(input.reason);
    if (!reason.success) throw new AppError("VALIDATION", reason.error.issues[0]!.message);
    const { o } = await loadOpp(tx, input.opportunityId);
    await moveStage(tx, input.orgId, o.id, o.stage, "disqualified", { type: "user", id: input.actorUserId }, `Disqualified: ${reason.data}`, { disqualifiedReason: reason.data });
  });
}

/**
 * Hand a qualified opportunity to Pipeline: an ordinary task for the sales
 * agent that saves the contact, opens a deal and adds a note. The prospect
 * travels as external data, so the CRM writes need approval (G7). The stage
 * becomes "opportunity" only when that task actually completes.
 */
export async function requestHandoff(input: User & { opportunityId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await access(tx, input, STAFF, "scout.handoff");
    const { o, p } = await loadOpp(tx, input.opportunityId);
    if (o.stage !== "qualified") throw new AppError("CONFLICT", "Only qualified opportunities can be handed to Pipeline.");
    if (o.handoffTaskId) {
      const [t] = await tx.select({ state: tasks.state }).from(tasks).where(eq(tasks.id, o.handoffTaskId));
      if (t && !["FAILED", "COMPLETED"].includes(t.state)) throw new AppError("CONFLICT", "A handoff for this opportunity is already in progress.");
    }
    if (!p.email) throw new AppError("VALIDATION", "Pipeline needs an email address for this person. Add one to your records and re-import.");
    const e = o.explanation as { whyRelevant?: string };
    const q = o.qualification as { note?: string } | null;
    const steps = [
      { tool: "crm.upsert_contact", args: { email: p.email, name: p.name, ...(p.phone ? { phone: p.phone } : {}) } },
      { tool: "crm.create_deal", args: { name: `Roofing: ${p.name}`.slice(0, 200), contactEmail: p.email } },
      { tool: "crm.add_note", args: { contactEmail: p.email, body: [`Handed off from Scout (heuristic score ${o.score}).`, e.whyRelevant ?? "", q?.note ? `Qualification note: ${q.note}` : ""].filter(Boolean).join("\n").slice(0, 5000) } },
    ];
    const { taskId } = await insertTask(tx, {
      orgId: input.orgId, actorUserId: input.actorUserId,
      title: `Hand off to Pipeline: ${p.name}`,
      intent: `Add ${p.name} to the CRM with a deal and a note (Scout handoff).`,
      input: { agentKind: "sales", scoutOpportunityId: o.id, prospect: { name: p.name, email: p.email, phone: p.phone } },
      plan: { direct: steps },
      auditMetadata: { scoutOpportunityId: o.id },
    });
    await tx.update(opportunities).set({ handoffTaskId: taskId, updatedAt: new Date() }).where(eq(opportunities.id, o.id));
    return { taskId };
  });
}

/**
 * Moves handed-off opportunities forward once their task completed, and
 * clears handoffs whose task failed or was rejected. Idempotent.
 */
export async function syncHandoffs(tx: Tx, tenantId: string): Promise<number> {
  const rows = await tx.select({ id: opportunities.id, taskId: opportunities.handoffTaskId, state: tasks.state }).from(opportunities)
    .innerJoin(tasks, and(eq(tasks.tenantId, opportunities.tenantId), eq(tasks.id, opportunities.handoffTaskId)))
    .where(and(eq(opportunities.stage, "qualified"), isNotNull(opportunities.handoffTaskId), inArray(tasks.state, ["COMPLETED", "FAILED"])));
  let moved = 0;
  for (const r of rows) {
    if (r.state === "COMPLETED") {
      await moveStage(tx, tenantId, r.id, "qualified", "opportunity", { type: "system", id: "pipeline-handoff" }, `Pipeline task ${r.taskId} completed: contact saved and deal opened in the CRM after approval.`);
      moved++;
    } else {
      await tx.update(opportunities).set({ handoffTaskId: null, updatedAt: new Date() }).where(eq(opportunities.id, r.id));
    }
  }
  return moved;
}

/**
 * An inbound email from a Scout prospect: they got in touch. Moves
 * prospect → engaged and records an inbound-inquiry permission for email,
 * unless they're on the do-not-contact list. Called by inbox sync.
 */
export async function noteInboundEmail(tx: Tx, tenantId: string, sender: string, ref: { messageId: string; sentAt: Date }) {
  const email = normalizeAddress(sender);
  const rows = await tx.select({ o: opportunities }).from(opportunities)
    .innerJoin(prospects, and(eq(prospects.tenantId, opportunities.tenantId), eq(prospects.id, opportunities.prospectId)))
    .where(and(eq(prospects.email, email), eq(opportunities.stage, "prospect")));
  if (!rows.length) return;
  const evidence = `Inbound email from ${email} on ${ref.sentAt.toISOString().slice(0, 10)} (message ${ref.messageId}).`;
  for (const { o } of rows) await moveStage(tx, tenantId, o.id, "prospect", "engaged", { type: "system", id: "inbox" }, evidence);
  const [blocked] = await tx.select({ id: suppressionList.id }).from(suppressionList).where(and(eq(suppressionList.channel, "email"), eq(suppressionList.value, email)));
  if (blocked) return;
  await tx.insert(communicationPermissions).values({ tenantId, channel: "email", value: email, basis: "inbound_inquiry", evidence, recordedBy: "system:inbox" }).onConflictDoNothing();
}

// ---------- permissions and do-not-contact ----------

const address = z.email().transform((e) => e.toLowerCase());

export async function recordPermission(input: User & { email: string; basis: string; evidence: string }) {
  return inOrg(input.orgId, async (tx) => {
    await access(tx, input, MANAGERS, "scout.permission.record");
    const p = z.object({ email: address, basis: z.enum(PERMISSION_BASES), evidence: evidenceText }).safeParse(input);
    if (!p.success) throw new AppError("VALIDATION", p.error.issues[0]!.message);
    const [s] = await tx.select({ id: suppressionList.id }).from(suppressionList).where(and(eq(suppressionList.channel, "email"), eq(suppressionList.value, p.data.email)));
    if (s) throw new AppError("CONFLICT", `${p.data.email} is on your do-not-contact list.`);
    const r = await tx.insert(communicationPermissions).values({ tenantId: input.orgId, channel: "email", value: p.data.email, basis: p.data.basis, evidence: p.data.evidence, recordedBy: input.actorUserId }).onConflictDoNothing().returning({ id: communicationPermissions.id });
    if (!r.length) throw new AppError("CONFLICT", `Permission for ${p.data.email} is already recorded.`);
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "scout.permission.record", target: `email:${p.data.email}`, tier: 1, outcome: "success", metadata: { basis: p.data.basis } });
  });
}

export async function revokePermission(input: User & { email: string }) {
  return inOrg(input.orgId, async (tx) => {
    await access(tx, input, STAFF, "scout.permission.revoke");
    const email = address.safeParse(input.email);
    if (!email.success) throw new AppError("VALIDATION", "Enter a valid email address.");
    await tx.update(communicationPermissions).set({ revokedAt: new Date(), revokedBy: input.actorUserId }).where(and(eq(communicationPermissions.value, email.data), isNull(communicationPermissions.revokedAt)));
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "scout.permission.revoke", target: `email:${email.data}`, tier: 1, outcome: "success" });
  });
}

/** Anyone on staff can add to do-not-contact; nobody can remove through the app. It also revokes any permission. */
export async function addSuppression(input: User & { email: string; reason: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "scout.suppress"); // no plan check: opting someone out must always work
    const p = z.object({ email: address, reason: z.enum(SUPPRESSION_REASONS) }).safeParse(input);
    if (!p.success) throw new AppError("VALIDATION", p.error.issues[0]!.message);
    await tx.insert(suppressionList).values({ tenantId: input.orgId, channel: "email", value: p.data.email, reason: p.data.reason, addedBy: input.actorUserId }).onConflictDoNothing();
    await tx.update(communicationPermissions).set({ revokedAt: new Date(), revokedBy: input.actorUserId }).where(and(eq(communicationPermissions.value, p.data.email), isNull(communicationPermissions.revokedAt)));
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "scout.suppress", target: `email:${p.data.email}`, tier: 1, outcome: "success", metadata: { reason: p.data.reason } });
  });
}

export async function listContactRules(input: User) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "scout.contact_rules.read");
    const perms = await tx.select().from(communicationPermissions).where(isNull(communicationPermissions.revokedAt)).orderBy(desc(communicationPermissions.recordedAt)).limit(500);
    const suppressed = await tx.select().from(suppressionList).orderBy(desc(suppressionList.createdAt)).limit(500);
    return { permissions: perms, suppressed };
  });
}

export async function getOpportunity(input: User & { opportunityId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await access(tx, input, STAFF, "scout.opportunity.read");
    await syncHandoffs(tx, input.orgId);
    const { o, p } = await loadOpp(tx, input.opportunityId);
    const events = await tx.select().from(opportunityEvents).where(eq(opportunityEvents.opportunityId, o.id)).orderBy(opportunityEvents.createdAt);
    const outreach = await tx.select().from(outreachEvents).where(eq(outreachEvents.opportunityId, o.id)).orderBy(desc(outreachEvents.createdAt)).limit(50);
    const email = p.email;
    const [perm] = email ? await tx.select().from(communicationPermissions).where(and(eq(communicationPermissions.value, email), isNull(communicationPermissions.revokedAt))) : [];
    const [supp] = email ? await tx.select().from(suppressionList).where(eq(suppressionList.value, email)) : [];
    const [handoff] = o.handoffTaskId ? await tx.select({ id: tasks.id, state: tasks.state }).from(tasks).where(eq(tasks.id, o.handoffTaskId)) : [];
    return { opportunity: o, prospect: p, events, outreach, permission: perm ?? null, suppressed: supp ?? null, handoff: handoff ?? null, qualificationQuestions: vertical(o.vertical).qualification };
  });
}

