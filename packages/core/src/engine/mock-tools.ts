import { z } from "zod";
import { ToolError, type ToolDefinition } from "./tools";

/**
 * MOCK tools for tests and local demos. They touch no real system. Each one
 * records what it "did" in an in-memory ledger keyed by idempotency key, which
 * is how a real provider with idempotency support behaves.
 */
export class MockLedger {
  readonly effects = new Map<string, { tool: string; args: unknown; at: number }>();
  calls = 0;
  /** Set to make the next N executions throw (retryable unless stated). */
  failNext: { count: number; retryable: boolean; afterEffect?: boolean } = { count: 0, retryable: true };

  record(key: string, tool: string, args: unknown) {
    this.calls++;
    if (this.failNext.count > 0 && !this.failNext.afterEffect) {
      this.failNext.count--;
      throw new ToolError("MOCK provider unavailable", this.failNext.retryable, "MOCK_DOWN");
    }
    if (!this.effects.has(key)) this.effects.set(key, { tool, args, at: Date.now() });
    if (this.failNext.count > 0 && this.failNext.afterEffect) {
      // The provider did the work, then the connection dropped before we heard back.
      this.failNext.count--;
      throw new Error("MOCK connection reset after the provider acted");
    }
    return { id: `mock_${key.slice(-12)}`, mock: true };
  }
}

export function mockTools(ledger: MockLedger): ToolDefinition[] {
  const make = <A>(name: string, tier: 0 | 1 | 2 | 3 | 4, args: z.ZodType<A>, summarize: (a: A) => string): ToolDefinition<A> => ({
    name,
    tier,
    args,
    mock: true,
    description: `MOCK ${name}`,
    output: z.object({ id: z.string(), mock: z.literal(true) }).passthrough(),
    summarize,
    execute: async (ctx, a) => ledger.record(ctx.idempotencyKey, name, a),
    reconcile: async (ctx) => {
      const e = ledger.effects.get(ctx.idempotencyKey);
      return e ? { id: `mock_${ctx.idempotencyKey.slice(-12)}`, mock: true, reconciled: true } : undefined;
    },
  });
  return [
    make("mock.lookup", 0, z.object({ q: z.string() }), (a) => `Look up "${a.q}"`),
    make("mock.note", 1, z.object({ text: z.string() }), (a) => `Add note: ${a.text}`),
    make("mock.send_email", 2, z.object({ to: z.email(), subject: z.string(), body: z.string() }), (a) => `Email ${a.to}: ${a.subject}`),
    make("mock.charge", 3, z.object({ customer: z.string(), amountCents: z.number().int().positive() }), (a) => `Charge ${a.customer} $${(a.amountCents / 100).toFixed(2)}`),
    make("mock.delete_contact", 4, z.object({ contactId: z.string() }), (a) => `Permanently delete contact ${a.contactId}`),
  ] as ToolDefinition[];
}
