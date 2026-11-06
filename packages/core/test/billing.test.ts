import Stripe from "stripe";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@wos/db";
import {
  AppError,
  closeUsagePeriod,
  configureEngine,
  createAgent,
  createOrg,
  createTask,
  getSubscription,
  handleStripeWebhook,
  inviteMember,
  meteringHooks,
  MockLedger,
  mockTools,
  ModelRouter,
  periodOf,
  runTask,
  setMonthlyBudget,
  stopBoss,
  ToolRegistry,
  usageSummary,
  WebhookSignatureError,
  type ModelProvider,
  type ModelResponse,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";
import { taskRow } from "./engine-helpers";

/** A non-mock provider double that reports token usage, so costs are non-zero. */
class MeteredFake implements ModelProvider {
  readonly name = "metered-fake";
  readonly mock = false;
  calls = 0;
  async complete(): Promise<ModelResponse> {
    this.calls++;
    return { text: "", toolCalls: [{ name: "mock.note", input: { text: "x" } }], usage: { inputTokens: 1000, outputTokens: 500 }, provider: this.name, model: "fake-1" };
  }
}

let orgId: string;
let provider: MeteredFake;
const SECRET = "whsec_test_secret";

async function expectCode(p: Promise<unknown>, code: AppError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
}

beforeEach(async () => {
  await resetDb();
  for (const u of ["owner", "member", "outsider"]) await seedUser(u, `${u}@example.test`);
  provider = new MeteredFake();
  configureEngine({ router: new ModelRouter([provider], "metered-fake", meteringHooks), tools: new ToolRegistry().register(...mockTools(new MockLedger())) });
  orgId = (await createOrg({ actorUserId: "owner", name: "Billing Co" })).orgId;
  await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
  await createAgent({ actorUserId: "owner", orgId, spec: { kind: "inbox", displayName: "Inbox", instructions: "x", tools: [{ name: "mock.note", maxTier: 1 }] } });
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

async function run() {
  const { taskId } = await createTask({ actorUserId: "member", orgId, intent: "note it", input: { agentKind: "inbox" } });
  return { taskId, state: await runTask(orgId, taskId) };
}

describe("metering", () => {
  it("records every model call's tokens and cost, and every tool call", async () => {
    expect((await run()).state).toBe("COMPLETED");
    const s = await usageSummary({ actorUserId: "member", orgId });
    // 1000 input x $3/M + 500 output x $15/M = $0.0105 = 10,500 micro-dollars (default configured prices).
    expect(s.byKind.find((k) => k.kind === "model_tokens")).toEqual({ kind: "model_tokens", quantity: 1500, costMicros: 10500, calls: 1 });
    expect(s.byKind.find((k) => k.kind === "tool_call")).toMatchObject({ quantity: 1, calls: 1 });
    expect(s.spentMicros).toBe(10500);
    expect(s.byAgent).toHaveLength(1);
  });

  it("stops AI work before the call once the month's budget is spent", async () => {
    await expectCode(setMonthlyBudget({ actorUserId: "member", orgId, budgetCents: 1 }), "FORBIDDEN");
    await setMonthlyBudget({ actorUserId: "owner", orgId, budgetCents: 1 }); // $0.01 = 10,000 micros
    expect((await run()).state).toBe("COMPLETED"); // spends 10,500
    const callsBefore = provider.calls;
    const second = await run();
    expect(second.state).toBe("FAILED");
    expect((await taskRow(orgId, second.taskId)).error).toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(provider.calls).toBe(callsBefore); // the over-budget call was never made
  });

  it("closes a month into the ledger once, matching usage exactly", async () => {
    await run();
    await run();
    const period = periodOf();
    expect(await closeUsagePeriod(orgId, period)).toEqual({ amountMicros: 21000, created: true });
    expect(await closeUsagePeriod(orgId, period)).toEqual({ amountMicros: 21000, created: false });
    const ledger = await withTenant(orgId, (tx) => tx.execute(sql`SELECT entry_type, amount_micros::int AS amt FROM billing_ledger`));
    expect(ledger.rows).toEqual([{ entry_type: "usage", amt: 21000 }]);
  });

  it("usage is not visible across tenants", async () => {
    await run();
    await expectCode(usageSummary({ actorUserId: "outsider", orgId }), "NOT_FOUND");
  });

  it("parallel model calls cannot all reserve past the monthly AI budget", async () => {
    await setMonthlyBudget({ actorUserId: "owner", orgId, budgetCents: 3 }); // $0.03 = 30,000 micros; reserve default 25,000 → at most one call
    const results = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => run()));
    const completed = results.filter((r) => r.state === "COMPLETED");
    const failed = results.filter((r) => r.state === "FAILED");
    expect(completed.length).toBe(1);
    expect(failed.length).toBe(7);
    expect(provider.calls).toBe(1);
    const s = await usageSummary({ actorUserId: "owner", orgId });
    expect(s.spentMicros).toBe(10500);
  });
});

describe("Stripe webhooks", () => {
  const sign = (payload: string, timestamp = Math.floor(Date.now() / 1000)) =>
    Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp });

  let clock = 1_790_000_000;
  function subscriptionEvent(id: string, tenantId: string, status = "active") {
    return JSON.stringify({
      id,
      object: "event",
      created: clock++,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_123", object: "subscription", customer: "cus_123", status, metadata: { tenantId }, items: { data: [{ price: { id: "price_basic" }, current_period_end: 1_800_000_000 }] } } },
    });
  }

  it("applies a verified subscription event and ignores its replay", async () => {
    const body = subscriptionEvent("evt_1", orgId);
    expect(await handleStripeWebhook(body, sign(body), { secret: SECRET })).toEqual({ status: "processed", type: "customer.subscription.updated" });
    expect(await getSubscription({ actorUserId: "member", orgId })).toMatchObject({ stripeSubscriptionId: "sub_123", status: "active", priceId: "price_basic" });
    expect(await handleStripeWebhook(body, sign(body), { secret: SECRET })).toMatchObject({ status: "duplicate" });
    const later = subscriptionEvent("evt_2", orgId, "past_due");
    await handleStripeWebhook(later, sign(later), { secret: SECRET });
    expect(await getSubscription({ actorUserId: "member", orgId })).toMatchObject({ status: "past_due" });
  });

  it("rejects bad signatures, wrong secrets and stale timestamps", async () => {
    const body = subscriptionEvent("evt_3", orgId);
    await expect(handleStripeWebhook(body, "t=1,v1=deadbeef", { secret: SECRET })).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(handleStripeWebhook(body, sign(body), { secret: "whsec_other" })).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(handleStripeWebhook(body, null, { secret: SECRET })).rejects.toBeInstanceOf(WebhookSignatureError);
    const stale = sign(body, Math.floor(Date.now() / 1000) - 600);
    await expect(handleStripeWebhook(body, stale, { secret: SECRET })).rejects.toBeInstanceOf(WebhookSignatureError);
    // A signed body that was altered after signing.
    const header = sign(body);
    await expect(handleStripeWebhook(body.replace("active", "canceled"), header, { secret: SECRET })).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it("ignores events for unknown or malformed tenants", async () => {
    const body = subscriptionEvent("evt_4", "00000000-0000-4000-8000-000000000000");
    expect(await handleStripeWebhook(body, sign(body), { secret: SECRET })).toMatchObject({ status: "ignored" });
    const bad = subscriptionEvent("evt_5", "'; DROP TABLE subscriptions; --");
    expect(await handleStripeWebhook(bad, sign(bad), { secret: SECRET })).toMatchObject({ status: "ignored" });
  });

  it("records a paid invoice once in the ledger, even if Stripe sends it twice under new event ids", async () => {
    const paid = (eventId: string) =>
      JSON.stringify({
        id: eventId,
        object: "event",
        type: "invoice.paid",
        data: { object: { id: "in_42", object: "invoice", amount_paid: 4900, created: 1_793_700_000, parent: { subscription_details: { metadata: { tenantId: orgId } } } } },
      });
    for (const id of ["evt_6", "evt_7"]) {
      const b = paid(id);
      await handleStripeWebhook(b, sign(b), { secret: SECRET });
    }
    const ledger = await withTenant(orgId, (tx) => tx.execute(sql`SELECT entry_type, amount_micros::bigint AS amt, stripe_ref FROM billing_ledger`));
    expect(ledger.rows).toEqual([{ entry_type: "subscription_payment", amt: "49000000", stripe_ref: "in_42" }]);
  });

  it("returns the newest subscription when an org has more than one row", async () => {
    await withTenant(orgId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, status, price_id, updated_at)
        VALUES
          (${orgId}, 'cus_old', 'sub_old', 'canceled', 'price_old', now() - interval '2 days'),
          (${orgId}, 'cus_new', 'sub_new', 'active', 'price_new', now() - interval '1 hour')`);
    });
    expect(await getSubscription({ actorUserId: "member", orgId })).toMatchObject({ stripeSubscriptionId: "sub_new", status: "active", priceId: "price_new" });
  });

  it("concurrent duplicate deliveries apply the event only once", async () => {
    const body = subscriptionEvent("evt_race", orgId);
    const header = sign(body);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => handleStripeWebhook(body, header, { secret: SECRET })));
    expect(results.filter((r) => r.status === "processed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(4);
    const n = await withTenant(orgId, async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM subscriptions`)).rows[0] as { n: number });
    expect(n.n).toBe(1);
  });

  it("ignores an older subscription.updated that arrives after a newer one", async () => {
    const newer = JSON.stringify({
      id: "evt_new",
      object: "event",
      created: 1_800_000_100,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_ord", object: "subscription", customer: "cus_ord", status: "active", metadata: { tenantId: orgId }, items: { data: [{ price: { id: "price_new" }, current_period_end: 1_800_000_000 }] } } },
    });
    const older = JSON.stringify({
      id: "evt_old",
      object: "event",
      created: 1_800_000_000,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_ord", object: "subscription", customer: "cus_ord", status: "past_due", metadata: { tenantId: orgId }, items: { data: [{ price: { id: "price_old" }, current_period_end: 1_800_000_000 }] } } },
    });
    expect(await handleStripeWebhook(newer, sign(newer), { secret: SECRET })).toMatchObject({ status: "processed" });
    expect(await handleStripeWebhook(older, sign(older), { secret: SECRET })).toMatchObject({ status: "ignored" });
    expect(await getSubscription({ actorUserId: "member", orgId })).toMatchObject({ status: "active", priceId: "price_new" });
  });
});
