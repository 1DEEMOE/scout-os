import { eq } from "drizzle-orm";
import { z } from "zod";
import { invoices, withTenant } from "@wos/db";
import { applyPaymentDestinationChange, PAYMENT_DETAIL_MIN_TIER } from "../finance/payment-guard";
import { ToolError, type ToolContext, type ToolDefinition, type ToolRegistry } from "../engine/tools";
import type { ProviderInvoice } from "../integrations/invoicing";
import type { InvoicingResolver } from "../finance/resolver";

export const money = (cents: number, currency = "usd") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

const MAX_CENTS = 1_000_000_00; // $1,000,000 per invoice; above that is not an agent's job

async function provider(resolve: InvoicingResolver, ctx: ToolContext) {
  const p = await resolve(ctx.tenantId);
  if (!p) throw new ToolError("No invoicing system is connected", false, "NO_INVOICING");
  return p;
}

async function invoiceById(ctx: ToolContext, id: string) {
  const [inv] = await withTenant(ctx.tenantId, (tx) => tx.select().from(invoices).where(eq(invoices.id, id)));
  if (!inv) throw new ToolError("Invoice not found", false, "NOT_FOUND");
  return inv;
}

/** Writes the provider's view of an invoice into our table. */
export async function storeInvoice(tenantId: string, providerName: "stripe" | "fake", i: ProviderInvoice) {
  return withTenant(tenantId, async (tx) => {
    const values = {
      number: i.number ?? null,
      customerEmail: i.customerEmail?.toLowerCase() ?? null,
      customerName: i.customerName ?? null,
      status: i.status,
      amountDueCents: i.amountDueCents,
      currency: i.currency,
      dueDate: i.dueDate ?? null,
      hostedUrl: i.hostedUrl ?? null,
      syncedAt: new Date(),
    };
    const [row] = await tx
      .insert(invoices)
      .values({ tenantId, provider: providerName, externalId: i.externalId, ...values })
      .onConflictDoUpdate({ target: [invoices.tenantId, invoices.provider, invoices.externalId], set: values })
      .returning({ id: invoices.id });
    return row!.id;
  });
}

export function financeTools(resolve: InvoicingResolver): ToolDefinition[] {
  const reminder: ToolDefinition<{ invoiceId: string }> = {
    name: "finance.send_invoice_reminder",
    description: "Email the customer a reminder for an open invoice (the invoicing system sends it).",
    tier: 2,
    args: z.object({ invoiceId: z.uuid() }),
    summarize: (a) => `Send a payment reminder for invoice ${a.invoiceId.slice(0, 8)}`,
    async execute(ctx, a) {
      const p = await provider(resolve, ctx);
      const inv = await invoiceById(ctx, a.invoiceId);
      if (inv.status !== "open") throw new ToolError(`Invoice is ${inv.status}; only open invoices get reminders`, false, "NOT_OPEN");
      await p.sendReminder(inv.externalId, ctx.idempotencyKey);
      await withTenant(ctx.tenantId, (tx) => tx.update(invoices).set({ lastReminderAt: new Date() }).where(eq(invoices.id, inv.id)));
      return { invoiceId: inv.id, to: inv.customerEmail };
    },
  };

  const create: ToolDefinition<{ customerEmail: string; customerName?: string; lines: { description: string; amountCents: number }[]; daysUntilDue: number }> = {
    name: "finance.create_invoice",
    description: "Create and send an invoice. Amounts are integer cents. Always needs a human.",
    tier: 3,
    args: z.object({
      customerEmail: z.email().transform((e) => e.toLowerCase()),
      customerName: z.string().max(200).optional(),
      lines: z.array(z.object({ description: z.string().trim().min(1).max(500), amountCents: z.number().int().positive().max(MAX_CENTS) })).min(1).max(25),
      daysUntilDue: z.number().int().min(0).max(120).default(30),
    }).refine((a) => a.lines.reduce((s, l) => s + l.amountCents, 0) <= MAX_CENTS, "Invoice total is over the $1,000,000 limit"),
    summarize: (a) => `Invoice ${a.customerEmail} for ${money(a.lines.reduce((s, l) => s + l.amountCents, 0))} (${a.lines.length} line${a.lines.length > 1 ? "s" : ""}, due in ${a.daysUntilDue} days)`,
    async execute(ctx, a) {
      const p = await provider(resolve, ctx);
      const created = await p.createInvoice({ ...a, currency: "usd" }, ctx.idempotencyKey);
      const invoiceId = await storeInvoice(ctx.tenantId, p.name, created);
      return { invoiceId, externalId: created.externalId, amountDueCents: created.amountDueCents };
    },
  };

  const voidIt: ToolDefinition<{ invoiceId: string; reason: string }> = {
    name: "finance.void_invoice",
    description: "Void an open invoice so it can no longer be paid.",
    tier: 3,
    args: z.object({ invoiceId: z.uuid(), reason: z.string().trim().min(1).max(500) }),
    summarize: (a) => `Void invoice ${a.invoiceId.slice(0, 8)}: ${a.reason}`,
    async execute(ctx, a) {
      const p = await provider(resolve, ctx);
      const inv = await invoiceById(ctx, a.invoiceId);
      const updated = await p.voidInvoice(inv.externalId, ctx.idempotencyKey);
      await storeInvoice(ctx.tenantId, p.name, updated);
      return { invoiceId: inv.id, status: updated.status };
    },
  };

  const updateDest: ToolDefinition<{
    kind: "customer" | "vendor" | "payee";
    label: string;
    contactId: string;
    accountNumber: string;
    routingNumber?: string;
    destinationId?: string;
    source?: "agent" | "email" | "chat" | "user";
  }> = {
    name: "finance.update_payment_destination",
    description:
      "Change a customer, vendor, or payee bank/remittance destination. Always needs tier-3 approval and a call-back on the phone already on file.",
    tier: PAYMENT_DETAIL_MIN_TIER,
    args: z.object({
      kind: z.enum(["customer", "vendor", "payee"]),
      label: z.string().trim().min(1).max(200),
      contactId: z.uuid(),
      accountNumber: z.string().min(4).max(32),
      routingNumber: z.string().min(9).max(9).optional(),
      destinationId: z.uuid().optional(),
      source: z.enum(["agent", "email", "chat", "user"]).optional(),
    }),
    summarize: (a) =>
      `Change ${a.kind} payment details for "${a.label}" (account ···${a.accountNumber.replace(/\D/g, "").slice(-4)})`,
    async execute(ctx, a) {
      return withTenant(ctx.tenantId, (tx) =>
        applyPaymentDestinationChange(tx, {
          tenantId: ctx.tenantId,
          actorId: ctx.agentId,
          kind: a.kind,
          contactId: a.contactId,
          label: a.label,
          accountNumber: a.accountNumber,
          routingNumber: a.routingNumber,
          destinationId: a.destinationId,
          taskId: ctx.taskId,
        }),
      );
    },
  };

  const payWithNew: ToolDefinition<{
    kind: "customer" | "vendor" | "payee";
    label: string;
    contactId: string;
    accountNumber: string;
    routingNumber?: string;
    amountCents: number;
    memo?: string;
    source?: "agent" | "email" | "chat" | "user";
  }> = {
    name: "finance.request_payment_with_new_destination",
    description:
      "Request a payment that also sets new bank/remittance details. Always needs tier-3 approval and a call-back on the phone already on file.",
    tier: PAYMENT_DETAIL_MIN_TIER,
    args: z.object({
      kind: z.enum(["customer", "vendor", "payee"]),
      label: z.string().trim().min(1).max(200),
      contactId: z.uuid(),
      accountNumber: z.string().min(4).max(32),
      routingNumber: z.string().min(9).max(9).optional(),
      amountCents: z.number().int().positive().max(MAX_CENTS),
      memo: z.string().max(500).optional(),
      source: z.enum(["agent", "email", "chat", "user"]).optional(),
    }),
    summarize: (a) =>
      `Pay ${money(a.amountCents)} to "${a.label}" using NEW account ···${a.accountNumber.replace(/\D/g, "").slice(-4)}`,
    async execute(ctx, a) {
      // Applying the destination is the guarded step; the actual payout is out of scope for gaps-1
      // (no live bank rail). We record the destination change only.
      const dest = await withTenant(ctx.tenantId, (tx) =>
        applyPaymentDestinationChange(tx, {
          tenantId: ctx.tenantId,
          actorId: ctx.agentId,
          kind: a.kind,
          contactId: a.contactId,
          label: a.label,
          accountNumber: a.accountNumber,
          routingNumber: a.routingNumber,
          taskId: ctx.taskId,
        }),
      );
      return { ...dest, amountCents: a.amountCents, memo: a.memo ?? null, payout: "recorded_destination_only" };
    },
  };

  return [reminder, create, voidIt, updateDest, payWithNew] as ToolDefinition[];
}

export function registerFinanceTools(registry: ToolRegistry, resolve: InvoicingResolver): void {
  registry.register(...financeTools(resolve));
}

