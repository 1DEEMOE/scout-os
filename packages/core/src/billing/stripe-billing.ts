import Stripe from "stripe";
import { desc, eq, sql } from "drizzle-orm";
import { billingLedger, isUuid, organizations, subscriptions, webhookEvents, withGlobal, withTenant } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { logger } from "../logger";
import { ANY_ROLE, inOrg, requireRole } from "../org/access";
import { periodOf } from "./metering";
import { applyPlan, planForSubscription } from "./plans";

/**
 * Platform billing: the SaaS charging its customers (not a tenant's own
 * Stripe). UNVERIFIED against Stripe: no platform key was available. Webhook
 * signature checks use Stripe's own library and are tested offline.
 * Env: STRIPE_SECRET_KEY, STRIPE_PRICE_ID (plan price, an owner decision),
 * STRIPE_WEBHOOK_SECRET.
 */
function platformStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new AppError("NOT_FOUND", "Billing is not configured on this server");
  return new Stripe(key, { maxNetworkRetries: 2 });
}

export async function createCheckout(input: { actorUserId: string; orgId: string; returnUrl: string }): Promise<{ url: string }> {
  await inOrg(input.orgId, (tx) => requireRole(tx, input.orgId, input.actorUserId, ["owner"], "billing.checkout"));
  const price = process.env.STRIPE_PRICE_ID;
  if (!price) throw new AppError("NOT_FOUND", "No plan price is configured (STRIPE_PRICE_ID)");
  const session = await platformStripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: input.orgId,
    metadata: { tenantId: input.orgId },
    subscription_data: { metadata: { tenantId: input.orgId } },
    success_url: `${input.returnUrl}?checkout=success`,
    cancel_url: `${input.returnUrl}?checkout=cancelled`,
  });
  return { url: session.url! };
}

export async function getSubscription(input: { actorUserId: string; orgId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "billing.read");
    // Newest subscription wins when an org has more than one row (E-1).
    const [sub] = await tx.select().from(subscriptions).orderBy(desc(subscriptions.updatedAt)).limit(1);
    return sub ?? null;
  });
}

export class WebhookSignatureError extends Error {
  constructor() {
    super("Invalid webhook signature");
    this.name = "WebhookSignatureError";
  }
}

type Result = { status: "processed" | "duplicate" | "ignored"; type: string };

/**
 * Verifies, de-duplicates and applies a Stripe webhook. Signature and a
 * 5-minute timestamp tolerance come from Stripe's library; event ids are
 * stored, so a replayed event is acknowledged and ignored. Processing is also
 * idempotent on its own (upserts, unique ledger refs).
 */
export async function handleStripeWebhook(rawBody: string, signature: string | null, opts: { secret?: string; now?: number } = {}): Promise<Result> {
  const secret = opts.secret ?? process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !signature) throw new WebhookSignatureError();
  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signature, secret, 300, undefined, opts.now);
  } catch {
    throw new WebhookSignatureError();
  }

  // Claim the event id first (atomic INSERT). Concurrent duplicates lose the
  // race here and never apply. If apply fails, release the claim so Stripe can retry.
  const claimed = await withGlobal(async (tx) => {
    const inserted = await tx
      .insert(webhookEvents)
      .values({ provider: "stripe", eventId: event.id, eventType: event.type })
      .onConflictDoNothing()
      .returning({ eventId: webhookEvents.eventId });
    return inserted.length > 0;
  });
  if (!claimed) return { status: "duplicate", type: event.type };

  try {
    const status = await apply(event);
    return { status, type: event.type };
  } catch (err) {
    await withGlobal((tx) => tx.execute(sql`DELETE FROM webhook_events WHERE provider = 'stripe' AND event_id = ${event.id}`));
    throw err;
  }
}

function tenantOf(meta: Stripe.Metadata | null | undefined): string | null {
  const t = meta?.tenantId;
  return t && isUuid(t) ? t : null;
}

async function apply(event: Stripe.Event): Promise<"processed" | "ignored"> {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const tenantId = tenantOf(sub.metadata);
      if (!tenantId) return ignore(event, "no tenant metadata");
      return withTenant(tenantId, async (tx) => {
        if (!(await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, tenantId))).length) return ignore(event, "unknown tenant");
        const eventAt = typeof event.created === "number" ? new Date(event.created * 1000) : new Date();
        const [existing] = await tx.select({ lastEventAt: subscriptions.lastEventAt }).from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, sub.id));
        if (existing?.lastEventAt && existing.lastEventAt > eventAt) return ignore(event, "older than the last applied event");
        const status = event.type === "customer.subscription.deleted" ? "canceled" : sub.status;
        const priceId = sub.items.data[0]?.price.id ?? null;
        const values = {
          stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
          status,
          priceId,
          currentPeriodEnd: sub.items.data[0]?.current_period_end ? new Date(sub.items.data[0].current_period_end * 1000) : null,
          updatedAt: new Date(),
          lastEventAt: eventAt,
        };
        await tx
          .insert(subscriptions)
          .values({ tenantId, stripeSubscriptionId: sub.id, ...values })
          .onConflictDoUpdate({ target: [subscriptions.tenantId, subscriptions.stripeSubscriptionId], set: values });
        // The plan follows the subscription. Unknown prices and inactive statuses fall back to the base plan.
        const next = planForSubscription(status, priceId);
        await applyPlan(tx, tenantId, next.plan, { type: "system", id: "stripe" }, next.reason);
        await recordAudit(tx, { tenantId, actorType: "system", actorId: "stripe", action: `billing.${event.type}`, target: `subscription:${sub.id}`, tier: 0, outcome: "success", metadata: { status, plan: next.plan } });
        return "processed" as const;
      });
    }
    case "invoice.paid": {
      const inv = event.data.object;
      const tenantId = tenantOf(inv.parent?.subscription_details?.metadata ?? inv.metadata);
      if (!tenantId) return ignore(event, "no tenant metadata");
      return withTenant(tenantId, async (tx) => {
        if (!(await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, tenantId))).length) return ignore(event, "unknown tenant");
        await tx
          .insert(billingLedger)
          .values({ tenantId, entryType: "subscription_payment", amountMicros: inv.amount_paid * 10_000, period: periodOf(new Date(inv.created * 1000)), stripeRef: inv.id! })
          .onConflictDoNothing();
        await recordAudit(tx, { tenantId, actorType: "system", actorId: "stripe", action: "billing.invoice.paid", target: `stripe_invoice:${inv.id}`, tier: 0, outcome: "success", metadata: { amountPaidCents: inv.amount_paid } });
        return "processed" as const;
      });
    }
    default:
      return "ignored";
  }
}

function ignore(event: Stripe.Event, why: string): "ignored" {
  logger.warn({ eventId: event.id, type: event.type, why }, "stripe webhook ignored");
  return "ignored";
}
