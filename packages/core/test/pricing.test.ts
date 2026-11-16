import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import {
  AppError,
  checkoutPriceForPlan,
  configureEngine,
  createCheckout,
  createOrg,
  inviteMember,
  MockModelProvider,
  ModelRouter,
  priceIdForPlan,
  pricingCards,
  pricingDisplayConfig,
  stopBoss,
  ToolRegistry,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

const ENV_KEYS = ["PRICING_DISPLAY_JSON", "STRIPE_PRICE_PLAN_MAP", "STRIPE_PRICE_ID", "STRIPE_SECRET_KEY"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("pricingDisplayConfig", () => {
  it("is empty when unset and parses display entries with defaults", () => {
    expect(pricingDisplayConfig()).toEqual([]);
    const cfg = pricingDisplayConfig(JSON.stringify([{ plan: "growth", price: "$249", blurb: "For growing teams.", highlight: true }]));
    expect(cfg).toEqual([{ plan: "growth", price: "$249", period: "/month", blurb: "For growing teams.", highlight: true }]);
  });

  it("fails loudly on malformed JSON, bad shape, and unknown plans", () => {
    expect(() => pricingDisplayConfig("{nope")).toThrow(/not valid JSON/);
    expect(() => pricingDisplayConfig(JSON.stringify([{ plan: "growth" }]))).toThrow(/invalid/);
    expect(() => pricingDisplayConfig(JSON.stringify([{ plan: "gold", price: "$1" }]))).toThrow(/unknown plan "gold"/);
  });
});

describe("priceIdForPlan", () => {
  it("inverts the webhook's price→plan map and refuses malformed maps", () => {
    process.env.STRIPE_PRICE_PLAN_MAP = JSON.stringify({ price_1Aaa: "growth", price_1Bbb: "scout_pro" });
    expect(priceIdForPlan("growth")).toBe("price_1Aaa");
    expect(priceIdForPlan("scout_pro")).toBe("price_1Bbb");
    expect(priceIdForPlan("starter")).toBeNull();
    process.env.STRIPE_PRICE_PLAN_MAP = "{broken";
    expect(() => priceIdForPlan("growth")).toThrow(/not valid JSON/);
  });
});

describe("checkoutPriceForPlan", () => {
  it("uses the legacy single price when no plan is passed", () => {
    expect(() => checkoutPriceForPlan()).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    process.env.STRIPE_PRICE_ID = "price_legacy";
    expect(checkoutPriceForPlan()).toEqual({ priceId: "price_legacy", trialDays: 0 });
  });

  it("rejects unknown and unmapped plans before any Stripe call, with the catalog trial otherwise", () => {
    process.env.STRIPE_PRICE_PLAN_MAP = JSON.stringify({ price_1Aaa: "growth" });
    expect(() => checkoutPriceForPlan("gold")).toThrowError(expect.objectContaining({ code: "VALIDATION" }));
    expect(() => checkoutPriceForPlan("scout_pro")).toThrowError(expect.objectContaining({ code: "VALIDATION" }));
    expect(() => checkoutPriceForPlan("enterprise")).toThrowError(expect.objectContaining({ code: "VALIDATION" }));
    // Growth carries a 14-day trial in the default catalog.
    expect(checkoutPriceForPlan("growth")).toEqual({ priceId: "price_1Aaa", trialDays: 14 });
  });
});

describe("pricingCards", () => {
  it("joins catalog, display config, and online purchasability", () => {
    process.env.PRICING_DISPLAY_JSON = JSON.stringify([{ plan: "growth", price: "$249", highlight: true }]);
    process.env.STRIPE_PRICE_PLAN_MAP = JSON.stringify({ price_1Aaa: "growth" });
    const withoutStripe = pricingCards();
    expect(withoutStripe.find((c) => c.plan.id === "growth")).toMatchObject({ purchasable: false, display: { price: "$249" } });
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    const withStripe = pricingCards();
    expect(withStripe.find((c) => c.plan.id === "growth")).toMatchObject({ purchasable: true });
    expect(withStripe.find((c) => c.plan.id === "starter")).toMatchObject({ purchasable: false, display: null });
  });
});

describe("createCheckout plan handling (no Stripe call is made)", () => {
  let orgId: string;
  beforeEach(async () => {
    await resetDb();
    await seedUser("owner", "owner@example.test");
    await seedUser("member", "member@example.test");
    configureEngine({ router: new ModelRouter([new MockModelProvider(() => ({}))], "mock"), tools: new ToolRegistry() });
    orgId = (await createOrg({ actorUserId: "owner", name: "Price Co" })).orgId;
    await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
  });
  afterAll(async () => {
    await stopBoss();
    await closePool();
  });

  const expectCode = (p: Promise<unknown>, code: AppError["code"]) =>
    expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);

  it("is owner-only, and validates the plan before Stripe is ever constructed", async () => {
    process.env.STRIPE_PRICE_PLAN_MAP = JSON.stringify({ price_1Aaa: "growth" });
    // No STRIPE_SECRET_KEY anywhere: a code path that reached Stripe would throw NOT_FOUND("Billing is not configured").
    await expectCode(createCheckout({ actorUserId: "member", orgId, plan: "growth", returnUrl: "http://x/b" }), "FORBIDDEN");
    await expectCode(createCheckout({ actorUserId: "owner", orgId, plan: "gold", returnUrl: "http://x/b" }), "VALIDATION");
    await expectCode(createCheckout({ actorUserId: "owner", orgId, plan: "scout_pro", returnUrl: "http://x/b" }), "VALIDATION");
    await expectCode(createCheckout({ actorUserId: "owner", orgId, returnUrl: "http://x/b" }), "NOT_FOUND"); // no STRIPE_PRICE_ID
    // A valid plan gets past validation and only then discovers Stripe is not configured here.
    await expect(createCheckout({ actorUserId: "owner", orgId, plan: "growth", returnUrl: "http://x/b" })).rejects.toThrow(/Billing is not configured/);
  });
});
