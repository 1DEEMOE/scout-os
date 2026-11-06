import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  approvalRequests,
  chatThreads,
  contacts,
  conversations,
  crmRecords,
  frontDeskBookings,
  invoices,
  isUuid,
  organizationMembers,
  tasks,
  users,
  type Role,
  type Tx,
} from "@wos/db";
import { ANY_ROLE, inOrg, requireRole } from "../org/access";
import { expireDue, type ApprovalRow } from "./approvals";
import { isOwnerOnly, ownerOnlyReason } from "./owner-only";
import { delegationOf } from "./executor";
import { taskLabel } from "./tasks";

/** A labelled fact about the thing an action touches, e.g. "Customer: Chen Bakery". */
export interface ContextLine {
  label: string;
  value: string;
}

/** What the person looking at the card can do, and why not if they can't. */
export type ReviewerState =
  | { kind: "can_approve"; note?: string }
  | { kind: "can_confirm" }
  | { kind: "read_only"; reason: string };

export interface ApprovalForReview {
  approval: ApprovalRow;
  /** The action's summary with record ids replaced by names a person recognises. */
  headline: string;
  taskId: string;
  taskTitle: string;
  requestedByName: string;
  decidedByName: string | null;
  /** Argument names whose values came from an email or chat message (G7). */
  externalDataFields: string[];
  /** Set when the lead bot handed this off from a chat conversation. */
  fromChat: { threadId: string; title: string } | null;
  context: ContextLine[];
  /** True when the task has other approvals still open, so approving this one alone won't run it. */
  otherOpenInTask: number;
  /** Only an owner may decide this one (bank-detail change, possibly forged invoice, first outreach). */
  ownerOnly: boolean;
  reviewer: ReviewerState;
}

const usd = (cents: number, currency = "usd") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

const ids = (rows: ApprovalRow[], key: string) =>
  [...new Set(rows.map((r) => (r.payload.args as Record<string, unknown> | undefined)?.[key]).filter((v): v is string => typeof v === "string" && isUuid(v)))];

/**
 * Turns the ids inside approval arguments into the facts a person needs to
 * decide: which customer, how much, due when, which email thread. Everything
 * is read inside the caller's tenant transaction, so it can't leak across orgs.
 */
async function contextFor(tx: Tx, rows: ApprovalRow[]): Promise<{ lines: Map<string, ContextLine[]>; headlines: Map<string, string> }> {
  const invoiceIds = ids(rows, "invoiceId");
  const dealIds = ids(rows, "dealId");
  const convIds = ids(rows, "conversationId");
  const inv = invoiceIds.length ? await tx.select().from(invoices).where(inArray(invoices.id, invoiceIds)) : [];
  const deals = dealIds.length
    ? await tx
        .select({ deal: crmRecords, contactName: contacts.name, contactEmail: contacts.email, company: contacts.company })
        .from(crmRecords)
        .leftJoin(contacts, eq(contacts.id, crmRecords.contactId))
        .where(inArray(crmRecords.id, dealIds))
    : [];
  const convs = convIds.length ? await tx.select().from(conversations).where(inArray(conversations.id, convIds)) : [];
  const today = new Date().toISOString().slice(0, 10);

  const out = new Map<string, ContextLine[]>();
  const headlines = new Map<string, string>();
  for (const r of rows) {
    const args = (r.payload.args ?? {}) as Record<string, unknown>;
    const lines: ContextLine[] = [];
    const i = inv.find((x) => x.id === args.invoiceId);
    if (i) {
      lines.push({ label: "Customer", value: [i.customerName, i.customerEmail].filter(Boolean).join(" · ") || "Unknown" });
      lines.push({ label: "Invoice", value: `${i.number ?? i.externalId} · ${usd(i.amountDueCents, i.currency)} due` });
      const overdue = i.status === "open" && i.dueDate && i.dueDate < today;
      const days = i.dueDate ? Math.round((Date.parse(today) - Date.parse(i.dueDate)) / 86_400_000) : 0;
      lines.push({ label: "Due", value: `${i.dueDate ?? "no due date"}${overdue ? ` (${days} day${days === 1 ? "" : "s"} overdue)` : ` · ${i.status}`}` });
      if (i.lastReminderAt) lines.push({ label: "Last reminder", value: i.lastReminderAt.toISOString().slice(0, 10) });
    } else if (typeof args.invoiceId === "string") {
      lines.push({ label: "Invoice", value: "Not found in this organization's records" });
    }
    const d = deals.find((x) => x.deal.id === args.dealId);
    if (d) {
      lines.push({ label: "Deal", value: d.deal.name });
      const who = [d.contactName, d.company, d.contactEmail].filter(Boolean).join(" · ");
      if (who) lines.push({ label: "Contact", value: who });
      lines.push({ label: "Now", value: `Stage ${d.deal.stage} · amount ${d.deal.amountCents === null ? "not set" : usd(d.deal.amountCents)}` });
      if (typeof args.amountCents === "number") lines.push({ label: "Change to", value: usd(args.amountCents) });
      if (typeof args.stage === "string") lines.push({ label: "Change to", value: `Stage ${args.stage}` });
    } else if (typeof args.dealId === "string") {
      lines.push({ label: "Deal", value: "Not found in this organization's records" });
    }
    const c = convs.find((x) => x.id === args.conversationId);
    if (c) lines.push({ label: "Email thread", value: c.subject || "(no subject)" });
    out.set(r.id, lines);
    // Tool summaries name records by id prefix ("invoice a9d9be08"); say which one it is.
    let headline = r.summary;
    if (i) headline = headline.replace(/invoice [0-9a-f]{8}\b/, `invoice ${i.number ?? i.externalId} (${i.customerName ?? i.customerEmail ?? "unknown customer"}, ${usd(i.amountDueCents, i.currency)})`);
    if (d) headline = headline.replace(/deal [0-9a-f]{8}\b/, `the "${d.deal.name}" deal`);
    headlines.set(r.id, headline);
  }
  return { lines: out, headlines };
}


function frontDeskRequesterName(
  requestedBy: string | undefined,
  booking: { customerName: string; requesterKind: string; agentName: string | null } | undefined,
): string | null {
  if (!requestedBy?.startsWith("front-desk:")) return null;
  const name = booking?.customerName?.trim();
  if (booking?.requesterKind === "ai_agent" && booking.agentName?.trim()) {
    return name ? `Front desk: ${name} (AI assistant: ${booking.agentName.trim()})` : `Front desk (AI assistant: ${booking.agentName.trim()})`;
  }
  return name ? `Front desk: ${name}` : "Front desk";
}

function reviewerState(
  a: ApprovalRow,
  me: { userId: string; role: Role | null },
  requestedBy: string,
  managers: { userId: string; role: Role }[],
): ReviewerState {
  const isManager = me.role === "owner" || me.role === "admin";
  const otherManagers = managers.filter((m) => m.userId !== me.userId);
  const otherOwners = otherManagers.filter((m) => m.role === "owner");

  if (a.status === "awaiting_confirmation") {
    if (me.role !== "owner") return { kind: "read_only", reason: "Approved once. Destructive actions need an owner's second confirmation." };
    if (a.decidedBy === me.userId) {
      return {
        kind: "read_only",
        reason: otherOwners.length
          ? "You gave the first approval. A different owner has to give the second confirmation."
          : "You gave the first approval, and there's no other owner to confirm it. Add a second owner in Settings, or reject it.",
      };
    }
    return { kind: "can_confirm" };
  }
  if (!isManager) return { kind: "read_only", reason: isOwnerOnly(a.toolName) ? ownerOnlyReason(a.toolName) : "Only owners and admins can approve." };
  if (isOwnerOnly(a.toolName)) {
    if (me.role !== "owner") return { kind: "read_only", reason: ownerOnlyReason(a.toolName) };
    if (requestedBy === me.userId) {
      if (otherOwners.length) return { kind: "read_only", reason: "You asked for this work, so another owner has to approve it." };
      return { kind: "can_approve", note: "You asked for this and you're the only owner, so your approval is recorded as a sole-owner exception." };
    }
  }
  if (requestedBy === me.userId) {
    if (otherManagers.length) return { kind: "read_only", reason: "You asked for this work, so another owner or admin has to approve it." };
    return { kind: "can_approve", note: "You asked for this and you're the only manager, so your approval is recorded as a sole-manager exception." };
  }
  if (a.tier === 4) {
    return {
      kind: "can_approve",
      note: otherOwners.length
        ? "Destructive action: after you approve, a different owner gives the second confirmation."
        : "Destructive action: it needs a second confirmation from a different owner, and there isn't one yet. Add a second owner in Settings before this can run.",
    };
  }
  return { kind: "can_approve" };
}

/**
 * Approvals as a reviewer should see them: open ones first, each with the
 * facts behind it and what this person may do. Read-only; decisions still
 * go through decideApproval / confirmApproval, which enforce the same rules.
 */
export async function approvalsForReview(input: { actorUserId: string; orgId: string; recentLimit?: number }): Promise<{ open: ApprovalForReview[]; recent: ApprovalForReview[] }> {
  return inOrg(input.orgId, async (tx) => {
    const role = await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "approval.list");
    await expireDue(tx, input.orgId);
    const open = await tx
      .select()
      .from(approvalRequests)
      .where(sql`${approvalRequests.status} IN ('pending', 'awaiting_confirmation')`)
      .orderBy(desc(approvalRequests.requestedAt))
      .limit(200);
    const recent = await tx
      .select()
      .from(approvalRequests)
      .where(sql`${approvalRequests.status} NOT IN ('pending', 'awaiting_confirmation')`)
      .orderBy(desc(sql`coalesce(${approvalRequests.decidedAt}, ${approvalRequests.requestedAt})`))
      .limit(input.recentLimit ?? 20);
    const all = [...open, ...recent];
    if (!all.length) return { open: [], recent: [] };

    const taskRows = await tx.select().from(tasks).where(inArray(tasks.id, [...new Set(all.map((a) => a.taskId))]));
    const threadIds = [...new Set(taskRows.map((t) => delegationOf(t.input)?.threadId).filter((v): v is string => !!v && isUuid(v)))];
    const threads = threadIds.length ? await tx.select({ id: chatThreads.id, title: chatThreads.title }).from(chatThreads).where(inArray(chatThreads.id, threadIds)) : [];
    const people = await tx
      .select({ userId: organizationMembers.userId, role: organizationMembers.role, name: users.name, email: users.email })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId));
    const nameOf = (id: string | null) => (id ? (people.find((p) => p.userId === id)?.name || people.find((p) => p.userId === id)?.email || "Former member") : null);
    const managers = people.filter((p) => p.role === "owner" || p.role === "admin");
    const bookingIds = ids(all, "bookingId");
    const deskBookings = bookingIds.length
      ? await tx.select().from(frontDeskBookings).where(inArray(frontDeskBookings.id, bookingIds))
      : [];
    const context = await contextFor(tx, all);
    const openByTask = new Map<string, number>();
    for (const a of open) openByTask.set(a.taskId, (openByTask.get(a.taskId) ?? 0) + 1);

    const shape = (a: ApprovalRow): ApprovalForReview => {
      const task = taskRows.find((t) => t.id === a.taskId);
      const d = delegationOf(task?.input);
      const thread = d ? threads.find((t) => t.id === d.threadId) : undefined;
      const isOpen = a.status === "pending" || a.status === "awaiting_confirmation";
      return {
        approval: a,
        headline: context.headlines.get(a.id) ?? a.summary,
        taskId: a.taskId,
        taskTitle: task ? taskLabel(task) : "Task",
        requestedByName:
          frontDeskRequesterName(
            task?.requestedBy,
            deskBookings.find((b) => b.id === (a.payload.args as { bookingId?: string } | undefined)?.bookingId),
          ) ??
          nameOf(task?.requestedBy ?? null) ??
          "Unknown",
        decidedByName: nameOf(a.decidedBy),
        externalDataFields: Array.isArray(a.payload.externalDataFields) ? (a.payload.externalDataFields as string[]) : [],
        fromChat: thread ? { threadId: thread.id, title: thread.title } : null,
        context: context.lines.get(a.id) ?? [],
        otherOpenInTask: isOpen ? (openByTask.get(a.taskId) ?? 1) - 1 : 0,
        ownerOnly: isOwnerOnly(a.toolName),
        reviewer: isOpen ? reviewerState(a, { userId: input.actorUserId, role }, task?.requestedBy ?? "", managers) : { kind: "read_only", reason: "" },
      };
    };
    return { open: open.map(shape), recent: recent.map(shape) };
  });
}
