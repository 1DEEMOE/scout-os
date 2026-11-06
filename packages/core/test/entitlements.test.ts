import Stripe from "stripe";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@wos/db";
import {
  AppError,
  assertSeatAvailable,
  configureEngine,
  consumeQuota,
  createOrg,
  createTask,
  entitlementsIn,
  handleStripeWebhook,
  inviteMember,
  MockLedger,
  mockTools,
  ModelRouter,
  MockModelProvider,
  operatorSetPlan,
  planCatalog,
  planForSubscription,
  planSpec,
  planSummary,
  requireFeature,
  resetPlanCatalogCache,
  stopBoss,
  ToolRegistry,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

const SECRET = "whsec_test_secret";
let orgId: string;

async function expectCode(p: Promise<unknown>, code: AppError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
}

async function audits(action: string) {
  return withTenant(orgId, async (tx) => (await tx.execute(sql`SELECT outcome, metadata FROM audit_events WHERE action = ${action} ORDER BY at`)).rows as { outcome: string; metadata: Record<string, unknown> }[]);
}

const ent = () => withTenant(orgId, (tx) => entitlementsIn(tx, orgId));

beforeEach(async () => {
  await resetDb();
  delete process.env.SCOUT_PLAN_CATALOG;
  process.env.STRIPE_PRICE_PLAN_MAP = JSON.stringify({ price_scout: "scout_pro", price_growth: "growth", price_bogus: "platinum" });
  resetPlanCatalogCache();
  for (const u of ["owner", "member", "outsider"]) await seedUser(u, `${u}@example.test`);
  configureEngine({ router: new ModelRouter([new MockModelProvider(() => ({}))], "mock"), tools: new ToolRegistry().register(...mockTools(new MockLedger())) });
  orgId = (await createOrg({ actorUserId: "owner", name: "Plans Co" })).orgId;
  await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
});

afterEach(() => {
  delete process.env.SCOUT_PLAN_CATALOG;
  delete process.env.STRIPE_PRICE_PLAN_MAP;
  resetPlanCatalogCache();
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("plan catalog", () => {
  it("has no prices, and new orgs start on the base plan (legacy 'free' reads as starter)", async () => {
    for (const p of planCatalog()) expect(Object.keys(p)).not.toContain("price");
    expect((await ent()).plan.id).toBe("starter");
    expect(planSpec("free").id).toBe("starter");
    expect(planSpec("nonsense").id).toBe("starter");
  });

  it("accepts a valid override and refuses an invalid one loudly", () => {
    process.env.SCOUT_PLAN_CATALOG = JSON.stringify([{ id: "starter", label: "Basic", features: ["core_agents"], limits: { seats: 2, tasks: 10, "scout.opportunities": 0, "scout.prospect_rows": 0 } }]);
    resetPlanCatalogCache();
    expect(planSpec("starter").label).toBe("Basic");
    process.env.SCOUT_PLAN_CATALOG = JSON.stringify([{ id: "pro", label: "Pro", features: [], limits: { seats: 1, tasks: 1, "scout.opportunities": 0, "scout.prospect_rows": 0 } }]);
    resetPlanCatalogCache();
    expect(() => planCatalog()).toThrow(/must include a "starter" plan/);
    process.env.SCOUT_PLAN_CATALOG = JSON.stringify([{ id: "starter", label: "x", features: ["teleport"], limits: {} }]);
    resetPlanCatalogCache();
    expect(() => planCatalog()).toThrow(/invalid/);
  });
});

describe("features", () => {
  it("refuses Scout on plans without it, audits the refusal, and allows it after an upgrade", async () => {
    await expectCode(withTenant(orgId, (tx) => requireFeature(tx, orgId, "scout", { type: "user", id: "owner" }, "scout.scan")), "UPGRADE_REQUIRED");
    const denied = await audits("scout.scan");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ outcome: "denied", metadata: { reason: "upgrade_required", feature: "scout", plan: "starter" } });
    await operatorSetPlan(orgId, "scout_pro", "test");
    await expect(withTenant(orgId, (tx) => requireFeature(tx, orgId, "scout", { type: "user", id: "owner" }, "scout.scan"))).resolves.toMatchObject({ plan: { id: "scout_pro" } });
  });

  it("operatorSetPlan refuses unknown plans and audits real changes", async () => {
    await expect(operatorSetPlan(orgId, "platinum", "test")).rejects.toThrow(/unknown plan/);
    await operatorSetPlan(orgId, "enterprise", "contract signed");
    expect((await audits("billing.plan.change"))[0]).toMatchObject({ outcome: "success", metadata: { from: "starter", to: "enterprise", reason: "contract signed" } });
  });
});

describe("quotas", () => {
  it("stops at the limit, keeps the counter exact and audits the refusal", async () => {
    process.env.SCOUT_PLAN_CATALOG = JSON.stringify([{ id: "starter", label: "Starter", features: ["core_agents"], limits: { seats: 5, tasks: 3, "scout.opportunities": 0, "scout.prospect_rows": 0 } }]);
    resetPlanCatalogCache();
    for (let i = 0; i < 3; i++) await createTask({ actorUserId: "member", orgId, intent: `t${i}`, input: {} });
    await expectCode(createTask({ actorUserId: "member", orgId, intent: "one too many", input: {} }), "QUOTA_EXCEEDED");
    const s = await planSummary({ actorUserId: "member", orgId });
    expect(s.usage.tasks).toBe(3);
    const [count] = await withTenant(orgId, async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM tasks`)).rows as { n: number }[]);
    expect(count!.n).toBe(3); // the refused task was not created
    expect((await audits("quota.exceeded"))[0]).toMatchObject({ outcome: "denied", metadata: { metric: "tasks", limit: 3 } });
  });

  it("can't be overshot by 20 concurrent consumers", async () => {
    await operatorSetPlan(orgId, "scout_pro", "test");
    process.env.SCOUT_PLAN_CATALOG = JSON.stringify([
      { id: "starter", label: "Starter", features: ["core_agents"], limits: { seats: 5, tasks: 500, "scout.opportunities": 0, "scout.prospect_rows": 0 } },
      { id: "scout_pro", label: "Scout Pro", features: ["core_agents", "scout"], limits: { seats: 5, tasks: 500, "scout.opportunities": 7, "scout.prospect_rows": 0 } },
    ]);
    resetPlanCatalogCache();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => withTenant(orgId, (tx) => consumeQuota(tx, orgId, "scout.opportunities", 1))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(7);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(13);
    for (const r of rejected) expect(r.reason).toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect((await planSummary({ actorUserId: "owner", orgId })).usage["scout.opportunities"]).toBe(7);
  });

  it("refuses a single request bigger than the whole allowance, and zero-limit metrics", async () => {
    await expectCode(withTenant(orgId, (tx) => consumeQuota(tx, orgId, "scout.prospect_rows", 1)), "QUOTA_EXCEEDED"); // starter: 0
    await operatorSetPlan(orgId, "scout_pro", "test");
    await expectCode(withTenant(orgId, (tx) => consumeQuota(tx, orgId, "scout.prospect_rows", 5001)), "QUOTA_EXCEEDED");
    await expect(withTenant(orgId, (tx) => consumeQuota(tx, orgId, "scout.prospect_rows", 5000))).resolves.toEqual({ used: 5000, limit: 5000 });
    await expect(withTenant(orgId, (tx) => consumeQuota(tx, orgId, "tasks", -1))).rejects.toThrow(/non-negative/);
  });

  it("says how much is left when a request is bigger than what remains", async () => {
    await operatorSetPlan(orgId, "scout_pro", "test");
    await withTenant(orgId, (tx) => consumeQuota(tx, orgId, "scout.prospect_rows", 7));
    await expect(withTenant(orgId, (tx) => consumeQuota(tx, orgId, "scout.prospect_rows", 5000))).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED", message: expect.stringMatching(/has 4,993 left; this needs 5,000\./) });
    await withTenant(orgId, (tx) => consumeQuota(tx, orgId, "scout.prospect_rows", 4993));
    await expect(withTenant(orgId, (tx) => consumeQuota(tx, orgId, "scout.prospect_rows", 1))).rejects.toThrow(/is used up\./);
  });

  it("unlimited plans count but never refuse", async () => {
    await operatorSetPlan(orgId, "enterprise", "test");
    await expect(withTenant(orgId, (tx) => consumeQuota(tx, orgId, "scout.prospect_rows", 1_000_000))).resolves.toEqual({ used: 1_000_000, limit: null });
  });
});

describe("seats", () => {
  it("refuses an invite past the plan's seats", async () => {
    process.env.SCOUT_PLAN_CATALOG = JSON.stringify([{ id: "starter", label: "Starter", features: ["core_agents"], limits: { seats: 2, tasks: 10, "scout.opportunities": 0, "scout.prospect_rows": 0 } }]);
    resetPlanCatalogCache();
    await expectCode(inviteMember({ actorUserId: "owner", orgId, email: "outsider@example.test", role: "member" }), "UPGRADE_REQUIRED");
    expect((await audits("org.invite")).at(-1)).toMatchObject({ outcome: "denied", metadata: { reason: "seat_limit", seats: 2 } });
    await expect(withTenant(orgId, (tx) => assertSeatAvailable(tx, orgId, "owner"))).rejects.toBeInstanceOf(AppError);
  });
});

describe("plan follows the Stripe subscription (signed webhooks)", () => {
  const sign = (payload: string) => Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp: Math.floor(Date.now() / 1000) });
  let n = 0;
  async function deliver(status: string, price: string | null, created: number, type = "customer.subscription.updated") {
    const body = JSON.stringify({
      id: `evt_${++n}`,
      object: "event",
      type,
      created,
      data: { object: { id: "sub_1", object: "subscription", customer: "cus_1", status, metadata: { tenantId: orgId }, items: { data: price ? [{ price: { id: price }, current_period_end: 1_800_000_000 }] : [] } } },
    });
    return handleStripeWebhook(body, sign(body), { secret: SECRET });
  }

  it("trial and active grant the mapped plan; past_due keeps it with a warning; cancel falls back", async () => {
    await deliver("trialing", "price_scout", 1000);
    expect((await ent()).plan.id).toBe("scout_pro");
    await deliver("active", "price_scout", 1001);
    expect(await ent()).toMatchObject({ plan: { id: "scout_pro" }, pastDue: false });
    await deliver("past_due", "price_scout", 1002);
    expect(await ent()).toMatchObject({ plan: { id: "scout_pro" }, pastDue: true });
    await deliver("canceled", "price_scout", 1003, "customer.subscription.deleted");
    expect(await ent()).toMatchObject({ plan: { id: "starter" }, billingStatus: "canceled" });
    const changes = (await audits("billing.plan.change")).map((a) => a.metadata.to);
    expect(changes).toEqual(["scout_pro", "starter"]);
  });

  it("unpaid and incomplete_expired fall back to the base plan", async () => {
    for (const [i, status] of ["unpaid", "incomplete_expired"].entries()) {
      await operatorSetPlan(orgId, "scout_pro", "test");
      await deliver(status, "price_scout", 2000 + i);
      expect((await ent()).plan.id).toBe("starter");
    }
  });

  it("unknown or mis-mapped prices grant nothing", async () => {
    await deliver("active", "price_unknown", 3000);
    expect((await ent()).plan.id).toBe("starter");
    await deliver("active", "price_bogus", 3001); // maps to a plan that isn't in the catalog
    expect((await ent()).plan.id).toBe("starter");
    expect(planForSubscription("active", null)).toEqual({ plan: "starter", reason: "price none not mapped to a plan" });
  });

  it("an older event delivered late can't restore a cancelled plan", async () => {
    await deliver("active", "price_scout", 4000);
    await deliver("canceled", "price_scout", 4002, "customer.subscription.deleted");
    expect(await deliver("active", "price_scout", 4001)).toMatchObject({ status: "ignored" });
    expect((await ent()).plan.id).toBe("starter");
  });

  it("a downgrade takes effect immediately for feature checks", async () => {
    await deliver("active", "price_scout", 5000);
    await expect(withTenant(orgId, (tx) => requireFeature(tx, orgId, "scout", { type: "agent", id: "a" }, "scout.scan"))).resolves.toBeTruthy();
    await deliver("active", "price_growth", 5001);
    await expectCode(withTenant(orgId, (tx) => requireFeature(tx, orgId, "scout", { type: "agent", id: "a" }, "scout.scan")), "UPGRADE_REQUIRED");
  });
});

describe("planSummary access", () => {
  it("members can read it; outsiders get NOT_FOUND", async () => {
    await expect(planSummary({ actorUserId: "member", orgId })).resolves.toMatchObject({ plan: { id: "starter" }, seatsUsed: 2 });
    await expectCode(planSummary({ actorUserId: "outsider", orgId }), "NOT_FOUND");
  });
});
