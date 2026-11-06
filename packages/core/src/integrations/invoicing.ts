export interface ProviderInvoice {
  externalId: string;
  number?: string;
  customerEmail?: string;
  customerName?: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  amountDueCents: number;
  currency: string;
  dueDate?: string; // YYYY-MM-DD
  hostedUrl?: string;
}

export interface NewInvoice {
  customerEmail: string;
  customerName?: string;
  lines: { description: string; amountCents: number }[];
  currency: string;
  daysUntilDue: number;
}

/** What the finance agent needs from an invoicing system. Stripe is one implementation. */
export interface InvoicingProvider {
  readonly name: "stripe" | "fake";
  readonly mock: boolean;
  listInvoices(): Promise<ProviderInvoice[]>;
  /** Idempotency key is passed to the provider, which deduplicates retries. */
  createInvoice(inv: NewInvoice, idempotencyKey: string): Promise<ProviderInvoice>;
  /** Re-sends the invoice email to the customer. */
  sendReminder(externalId: string, idempotencyKey: string): Promise<void>;
  voidInvoice(externalId: string, idempotencyKey: string): Promise<ProviderInvoice>;
}

/** MOCK invoicing for tests and demos. Honors idempotency keys like Stripe does. */
export class FakeInvoicingProvider implements InvoicingProvider {
  readonly name = "fake" as const;
  readonly mock = true;
  invoices = new Map<string, ProviderInvoice>();
  reminders: { externalId: string; key: string }[] = [];
  private byKey = new Map<string, unknown>();
  calls = 0;

  private once<T>(key: string, fn: () => T): T {
    this.calls++;
    if (this.byKey.has(key)) return this.byKey.get(key) as T;
    const r = fn();
    this.byKey.set(key, r);
    return r;
  }

  async listInvoices() {
    return [...this.invoices.values()];
  }

  async createInvoice(inv: NewInvoice, key: string) {
    return this.once(key, () => {
      const externalId = `fin_${this.invoices.size + 1}`;
      const due = new Date(Date.now() + inv.daysUntilDue * 86400000).toISOString().slice(0, 10);
      const created: ProviderInvoice = {
        externalId,
        number: `MOCK-${this.invoices.size + 1}`,
        customerEmail: inv.customerEmail,
        customerName: inv.customerName,
        status: "open",
        amountDueCents: inv.lines.reduce((s, l) => s + l.amountCents, 0),
        currency: inv.currency,
        dueDate: due,
      };
      this.invoices.set(externalId, created);
      return created;
    });
  }

  async sendReminder(externalId: string, key: string) {
    this.once(key, () => this.reminders.push({ externalId, key }));
  }

  async voidInvoice(externalId: string, key: string) {
    return this.once(key, () => {
      const inv = this.invoices.get(externalId);
      if (!inv) throw new Error(`MOCK: invoice ${externalId} not found`);
      inv.status = "void";
      return inv;
    });
  }
}
