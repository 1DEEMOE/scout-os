import { and, asc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { invoices } from "@wos/db";
import { recordAudit } from "../audit";
import { createTask } from "../engine/tasks";
import { getEngine } from "../engine/runtime";
import { AppError } from "../errors";
import { upsertConnection } from "../integrations/connections";
import { ANY_ROLE, inOrg, requireRole, STAFF } from "../org/access";
import { money, storeInvoice } from "../tools/finance";

/** Stores a Stripe secret key, encrypted. Owners only: it can move money. */
export async function connectStripe(input: { actorUserId: string; orgId: string; secretKey: string }) {
  const key = z.string().trim().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, "That doesn't look like a Stripe secret or restricted key").parse(input.secretKey);
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ["owner"], "integration.connect");
    const live = key.includes("_live_");
    const conn = await upsertConnection(tx, { tenantId: input.orgId, provider: "stripe", accountLabel: live ? "Stripe (live)" : "Stripe (test mode)", scopes: [], secret: { secretKey: key }, createdBy: input.actorUserId });
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "integration.connect", target: `integration:${conn.id}`, tier: 4, outcome: "success", metadata: { provider: "stripe", live } });
    return { connectionId: conn.id, live };
  });
}

export async function syncInvoices(input: { actorUserId: string; orgId: string }): Promise<{ synced: number; mock: boolean }> {
  await inOrg(input.orgId, (tx) => requireRole(tx, input.orgId, input.actorUserId, STAFF, "finance.sync"));
  const resolve = getEngine().invoicing;
  const p = resolve ? await resolve(input.orgId) : null;
  if (!p) throw new AppError("NOT_FOUND", "No invoicing system is connected");
  const list = await p.listInvoices();
  for (const i of list) await storeInvoice(input.orgId, p.name, i);
  await inOrg(input.orgId, (tx) =>
    recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "finance.sync", tier: 0, outcome: "success", metadata: { count: list.length, mock: p.mock } }),
  );
  return { synced: list.length, mock: p.mock };
}

export async function listInvoices(input: { actorUserId: string; orgId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "finance.list");
    return tx.select().from(invoices).orderBy(asc(invoices.dueDate)).limit(500);
  });
}


/** Open invoices whose due date is before today (YYYY-MM-DD). Paid invoices are never overdue. */
export function isOverdueInvoice(i: { status: string; dueDate: string | null }, today: string): boolean {
  return i.status === "open" && !!i.dueDate && i.dueDate < today;
}

export function partitionInvoices<T extends { status: string; dueDate: string | null }>(
  invoices: T[],
  today: string,
): { overdue: T[]; other: T[] } {
  const overdue: T[] = [];
  const other: T[] = [];
  for (const i of invoices) (isOverdueInvoice(i, today) ? overdue : other).push(i);
  return { overdue, other };
}

/** Open invoices past their due date (compared as calendar dates, UTC). */
export async function findOverdue(input: { actorUserId: string; orgId: string; today?: string }) {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "finance.overdue");
    return tx.select().from(invoices).where(and(eq(invoices.status, "open"), lt(invoices.dueDate, today))).orderBy(asc(invoices.dueDate));
  });
}

/** Hands overdue invoices to the finance agent to propose reminders (each one needs approval). */
export async function chaseOverdue(input: { actorUserId: string; orgId: string; today?: string }) {
  const overdue = await findOverdue(input);
  if (!overdue.length) return { taskId: null, overdue: 0 };
  const { taskId } = await createTask({
    actorUserId: input.actorUserId,
    orgId: input.orgId,
    title: `Payment reminders for ${overdue.length} overdue invoice${overdue.length === 1 ? "" : "s"}`,
    intent: "Propose a payment reminder (finance.send_invoice_reminder) for each overdue invoice below. Skip any reminded in the last 7 days.",
    input: {
      agentKind: "finance",
      overdue: overdue.map((i) => ({ invoiceId: i.id, customer: i.customerEmail, amount: money(i.amountDueCents, i.currency), dueDate: i.dueDate, lastReminderAt: i.lastReminderAt?.toISOString() ?? null })),
    },
  });
  return { taskId, overdue: overdue.length };
}

