import { z } from "zod";
import { AppError } from "../errors";
import { planCatalog, planSpec, type PlanSpec } from "./plans";

/**
 * Public pricing presentation + plan→price resolution.
 *
 * No price numbers live in this repo on purpose (owner decision, CLAUDE.md).
 * Display prices come from PRICING_DISPLAY_JSON and checkout prices from the
 * Stripe-side STRIPE_PRICE_PLAN_MAP (price_… → plan id, already used by the
 * webhook). Both are config; both are validated; invalid config fails loudly
 * in this module, and the public page degrades to plan cards without prices
 * rather than showing a wrong number.
 */

const displayEntry = z.object({
  plan: z.string().regex(/^[a-z_]+$/),
  /** Display string only ("$249"). The amount Stripe charges lives in Stripe. */
  price: z.string().trim().min(1).max(30),
  period: z.string().trim().min(1).max(30).default("/month"),
  blurb: z.string().trim().max(240).optional(),
  highlight: z.boolean().optional(),
});
export type PricingDisplay = z.infer<typeof displayEntry>;

/** Parses PRICING_DISPLAY_JSON. Throws on malformed config (loud, like planCatalog). */
export function pricingDisplayConfig(raw = process.env.PRICING_DISPLAY_JSON): PricingDisplay[] {
  if (!raw) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("PRICING_DISPLAY_JSON is not valid JSON");
  }
  const parsed = z.array(displayEntry).safeParse(json);
  if (!parsed.success) throw new Error(`PRICING_DISPLAY_JSON is invalid: ${parsed.error.issues[0]?.message}`);
  const catalog = planCatalog();
  for (const d of parsed.data) {
    if (!catalog.some((p) => p.id === d.plan)) throw new Error(`PRICING_DISPLAY_JSON names unknown plan "${d.plan}"`);
  }
  return parsed.data;
}

/** plan id → Stripe price id, from the webhook's STRIPE_PRICE_PLAN_MAP (price → plan). */
export function priceIdForPlan(planId: string, rawMap = process.env.STRIPE_PRICE_PLAN_MAP): string | null {
  let map: Record<string, string>;
  try {
    map = JSON.parse(rawMap ?? "{}") as Record<string, string>;
  } catch {
    throw new Error("STRIPE_PRICE_PLAN_MAP is not valid JSON");
  }
  for (const [priceId, mappedPlan] of Object.entries(map)) if (mappedPlan === planId) return priceId;
  return null;
}

/**
 * The price and trial a checkout for `planId` uses. Without a plan id the
 * legacy single-price config (STRIPE_PRICE_ID) applies. Unknown plans,
 * non-catalog plans, and plans with no mapped Stripe price are refused
 * before any network call.
 */
export function checkoutPriceForPlan(planId?: string): { priceId: string; trialDays: number } {
  if (!planId) {
    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) throw new AppError("NOT_FOUND", "No plan price is configured (STRIPE_PRICE_ID)");
    return { priceId, trialDays: 0 };
  }
  const catalog = planCatalog();
  if (!catalog.some((p) => p.id === planId)) throw new AppError("VALIDATION", `Unknown plan "${planId}".`);
  const priceId = priceIdForPlan(planId);
  if (!priceId) throw new AppError("VALIDATION", `The ${planSpec(planId).label} plan isn't available for online checkout. Contact us instead.`);
  return { priceId, trialDays: planSpec(planId).trialDays };
}

export interface PricingCard {
  plan: PlanSpec;
  display: PricingDisplay | null;
  /** True when Stripe is configured and this plan has a mapped price. */
  purchasable: boolean;
}

/**
 * The public pricing page model: every catalog plan, its display config when
 * the owner published one, and whether it can be bought online right now.
 */
export function pricingCards(): PricingCard[] {
  const display = pricingDisplayConfig();
  const stripeReady = !!process.env.STRIPE_SECRET_KEY;
  return planCatalog().map((plan) => {
    const d = display.find((x) => x.plan === plan.id) ?? null;
    return { plan, display: d, purchasable: stripeReady && priceIdForPlan(plan.id) !== null };
  });
}
