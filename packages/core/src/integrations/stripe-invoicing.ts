import Stripe from "stripe";
import type { InvoicingProvider, NewInvoice, ProviderInvoice } from "./invoicing";

/**
 * Stripe Invoicing adapter (use a TEST-mode key until live acceptance).
 * UNVERIFIED against Stripe: no key was available in any build session.
 * Request shapes are unit-tested with a stubbed client. Every write passes
 * Stripe's native Idempotency-Key, derived from the workflow step.
 */
type StripeLike = Pick<Stripe, "customers" | "invoices" | "invoiceItems">;

function fromStripe(i: Stripe.Invoice): ProviderInvoice {
  return {
    externalId: i.id!,
    number: i.number ?? undefined,
    customerEmail: i.customer_email ?? undefined,
    customerName: i.customer_name ?? undefined,
    status: (i.status ?? "draft") as ProviderInvoice["status"],
    amountDueCents: i.amount_due,
    currency: i.currency,
    dueDate: i.due_date ? new Date(i.due_date * 1000).toISOString().slice(0, 10) : undefined,
    hostedUrl: i.hosted_invoice_url ?? undefined,
  };
}

export class StripeInvoicingProvider implements InvoicingProvider {
  readonly name = "stripe" as const;
  readonly mock = false;
  private readonly stripe: StripeLike;

  constructor(secretKey: string, client?: StripeLike) {
    this.stripe = client ?? new Stripe(secretKey, { maxNetworkRetries: 2 });
  }

  async listInvoices(): Promise<ProviderInvoice[]> {
    const out: ProviderInvoice[] = [];
    for await (const i of this.stripe.invoices.list({ limit: 100 })) {
      out.push(fromStripe(i));
      if (out.length >= 500) break;
    }
    return out;
  }

  async createInvoice(inv: NewInvoice, key: string): Promise<ProviderInvoice> {
    const existing = await this.stripe.customers.list({ email: inv.customerEmail, limit: 1 });
    const customer =
      existing.data[0] ??
      (await this.stripe.customers.create({ email: inv.customerEmail, name: inv.customerName }, { idempotencyKey: `${key}:customer` }));
    const draft = await this.stripe.invoices.create(
      { customer: customer.id, collection_method: "send_invoice", days_until_due: inv.daysUntilDue, currency: inv.currency, auto_advance: false },
      { idempotencyKey: `${key}:invoice` },
    );
    for (const [n, line] of inv.lines.entries()) {
      await this.stripe.invoiceItems.create(
        { customer: customer.id, invoice: draft.id!, amount: line.amountCents, currency: inv.currency, description: line.description },
        { idempotencyKey: `${key}:line:${n}` },
      );
    }
    const finalized = await this.stripe.invoices.finalizeInvoice(draft.id!, {}, { idempotencyKey: `${key}:finalize` });
    return fromStripe(finalized);
  }

  async sendReminder(externalId: string, key: string): Promise<void> {
    await this.stripe.invoices.sendInvoice(externalId, {}, { idempotencyKey: key });
  }

  async voidInvoice(externalId: string, key: string): Promise<ProviderInvoice> {
    return fromStripe(await this.stripe.invoices.voidInvoice(externalId, {}, { idempotencyKey: key }));
  }
}
