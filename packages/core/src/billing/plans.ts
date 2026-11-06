import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { organizationMembers, organizations, subscriptions, usageCounters, withTenant, withTenantOutOfBand, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { logger } from "../logger";
import { auditDenied, inOrg, ANY_ROLE, requireRole } from "../org/access";

/**
 * Plans, features and quotas (ADR-004 §3).
 *
 * The catalog is a PRODUCT HYPOTHESIS: names and limits are defaults,
 * overridable with SCOUT_PLAN_CATALOG. There are no prices here on purpose;
 * prices live in Stripe and are an owner decision.
 *
 * Every check in this file runs on the server inside the tenant's
 * transaction. Hiding a button is never the enforcement.
 */
export const FEATURES = ["core_agents", "chat", "crm", "finance", "scout"] as const;
export type Feature = (typeof FEATURES)[number];

export const METRICS = ["tasks", "scout.opportunities", "scout.prospect_rows", "routine.runs"] as const;
export type Metric = (typeof METRICS)[number];

const limitSchema = z.number().int().nonnegative().nullable(); // null = no limit (custom contract)
const planSchema = z.object({
  id: z.string().regex(/^[a-z_]+$/),
  label: z.string().min(1),
  features: z.array(z.enum(FEATURES)),
  limits: z.object({
    seats: limitSchema,
    tasks: limitSchema,
    "scout.opportunities": limitSchema,
    "scout.prospect_rows": limitSchema,
    // R1. Optional so older SCOUT_PLAN_CATALOG values still parse; missing means 0 (fail closed).
    routines: limitSchema.default(0),
    "routine.runs": limitSchema.default(0),
  }),
  trialDays: z.number().int().nonnegative().default(0),
});
export type PlanSpec = z.infer<typeof planSchema>;

const CORE: Feature[] = ["core_agents", "chat", "crm", "finance"];

export const DEFAULT_CATALOG: PlanSpec[] = [
  { id: "starter", label: "Starter", features: CORE, limits: { seats: 5, tasks: 500, "scout.opportunities": 0, "scout.prospect_rows": 0, routines: 1, "routine.runs": 62 }, trialDays: 0 },
  { id: "growth", label: "Growth", features: CORE, limits: { seats: 15, tasks: 5000, "scout.opportunities": 0, "scout.prospect_rows": 0, routines: 5, "routine.runs": 310 }, trialDays: 14 },
  { id: "scout_pro", label: "Scout Pro", features: [...CORE, "scout"], limits: { seats: 15, tasks: 5000, "scout.opportunities": 500, "scout.prospect_rows": 5000, routines: 10, "routine.runs": 1000 }, trialDays: 14 },
  { id: "enterprise", label: "Enterprise", features: [...CORE, "scout"], limits: { seats: null, tasks: null, "scout.opportunities": null, "scout.prospect_rows": null, routines: null, "routine.runs": null }, trialDays: 0 },
];

/** The plan anything unknown, cancelled or unpaid falls back to. */
export const BASE_PLAN = "starter";
/** Values written by earlier versions that mean the base plan. */
const ALIASES: Record<string, string> = { free: BASE_PLAN };

let cached: PlanSpec[] | undefined;

/** The active catalog: SCOUT_PLAN_CATALOG if set and valid, else the defaults. Invalid config fails loudly. */
export function planCatalog(): PlanSpec[] {
  if (cached) return cached;
  const raw = process.env.SCOUT_PLAN_CATALOG;
  if (!raw) return (cached = DEFAULT_CATALOG);
  const parsed = z.array(planSchema).min(1).safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`SCOUT_PLAN_CATALOG is invalid: ${parsed.error.issues[0]?.message}`);
  if (!parsed.data.some((p) => p.id === BASE_PLAN)) throw new Error(`SCOUT_PLAN_CATALOG must include a "${BASE_PLAN}" plan`);
  return (cached = parsed.data);
}

/** For tests that change SCOUT_PLAN_CATALOG. */
export function resetPlanCatalogCache(): void {
  cached = undefined;
}

export function planSpec(id: string | null | undefined): PlanSpec {
  const catalog = planCatalog();
  const key = ALIASES[id ?? ""] ?? id ?? BASE_PLAN;
  return catalog.find((p) => p.id === key) ?? catalog.find((p) => p.id === BASE_PLAN)!;
}

export interface Entitlements {
  plan: PlanSpec;
  /** Latest platform subscription status from Stripe, or null when there is none. */
  billingStatus: string | null;
  /** Payment failed; access kept for now (grace). */
  pastDue: boolean;
}

export async function entitlementsIn(tx: Tx, tenantId: string): Promise<Entitlements> {
  const [org] = await tx.select({ plan: organizations.plan }).from(organizations).where(eq(organizations.id, tenantId));
  const [sub] = await tx.select({ status: subscriptions.status }).from(subscriptions).orderBy(desc(subscriptions.updatedAt)).limit(1);
  return { plan: planSpec(org?.plan), billingStatus: sub?.status ?? null, pastDue: sub?.status === "past_due" };
}

export const currentPeriod = (d = new Date()) => d.toISOString().slice(0, 7);

const FEATURE_LABEL: Record<Feature, string> = {
  core_agents: "AI agents",
  chat: "Chat",
  crm: "Pipeline",
  finance: "Billing",
  scout: "Scout lead intelligence",
};

/**
 * Throws UPGRADE_REQUIRED unless the org's plan includes the feature. Call
 * after requireRole, so non-members still get NOT_FOUND. The refusal is
 * audited in its own transaction (the caller's rolls back).
 */
export async function requireFeature(tx: Tx, tenantId: string, feature: Feature, actor: { type: "user" | "agent" | "system"; id: string }, action: string): Promise<Entitlements> {
  const ent = await entitlementsIn(tx, tenantId);
  if (!ent.plan.features.includes(feature)) {
    if (actor.type === "user") await auditDenied(tenantId, actor.id, action, { reason: "upgrade_required", feature, plan: ent.plan.id });
    else await withTenantOutOfBand(tenantId, (t) => recordAudit(t, { tenantId, actorType: actor.type, actorId: actor.id, action, outcome: "denied", tier: 0, metadata: { reason: "upgrade_required", feature, plan: ent.plan.id } }));
    throw new AppError("UPGRADE_REQUIRED", `${FEATURE_LABEL[feature]} isn't included in the ${ent.plan.label} plan.`, { feature, plan: ent.plan.id });
  }
  return ent;
}

/**
 * Atomically uses `n` of this month's allowance. One SQL statement: the
 * increment only happens if it stays within the limit, so concurrent callers
 * can't overshoot (no read-then-write race). Throws QUOTA_EXCEEDED otherwise.
 */
export async function consumeQuota(tx: Tx, tenantId: string, metric: Metric, n: number): Promise<{ used: number; limit: number | null }> {
  if (!Number.isInteger(n) || n < 0) throw new Error("quota amount must be a non-negative integer");
  const ent = await entitlementsIn(tx, tenantId);
  const limit = ent.plan.limits[metric];
  const period = currentPeriod();
  if (limit !== null && n > limit) throw new AppError("QUOTA_EXCEEDED", quotaMessage(metric, limit, ent.plan.label), { metric, limit });
  const rows = await tx.execute(sql`
    INSERT INTO usage_counters (tenant_id, metric, period, used)
    VALUES (${tenantId}, ${metric}, ${period}, ${n})
    ON CONFLICT (tenant_id, metric, period)
    DO UPDATE SET used = usage_counters.used + EXCLUDED.used, updated_at = now()
    WHERE ${limit === null ? sql`true` : sql`usage_counters.used + EXCLUDED.used <= ${limit}`}
    RETURNING used`);
  const row = rows.rows[0] as { used: number } | undefined;
  if (!row) {
    // Audited in its own transaction: the caller's rolls back when we throw.
    await withTenantOutOfBand(tenantId, (t) => recordAudit(t, { tenantId, actorType: "system", actorId: "quota", action: "quota.exceeded", tier: 0, outcome: "denied", metadata: { metric, limit, requested: n, period } }));
    const cur = await tx.execute(sql`SELECT used FROM usage_counters WHERE tenant_id = ${tenantId} AND metric = ${metric} AND period = ${period}`);
    const left = Math.max(0, limit! - Number((cur.rows[0] as { used: number } | undefined)?.used ?? 0));
    throw new AppError("QUOTA_EXCEEDED", quotaMessage(metric, limit!, ent.plan.label, left, n), { metric, limit, remaining: left });
  }
  return { used: Number(row.used), limit };
}

function quotaMessage(metric: Metric, limit: number, plan: string, left = 0, requested = 0): string {
  const what = { tasks: "tasks", "scout.opportunities": "new Scout opportunities", "scout.prospect_rows": "imported prospect rows", "routine.runs": "routine runs" }[metric];
  const allowance = `This month's allowance of ${limit.toLocaleString("en-US")} ${what} on the ${plan} plan`;
  // Say how much is left when the request is just too big, rather than "used up".
  if (left > 0 && requested > left) return `${allowance} has ${left.toLocaleString("en-US")} left; this needs ${requested.toLocaleString("en-US")}.`;
  return `${allowance} is used up.`;
}

/** Seat check for inviting a member. */
export async function assertSeatAvailable(tx: Tx, tenantId: string, actorUserId: string): Promise<void> {
  const ent = await entitlementsIn(tx, tenantId);
  if (ent.plan.limits.seats === null) return;
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(organizationMembers).where(eq(organizationMembers.tenantId, tenantId));
  if ((r?.n ?? 0) >= ent.plan.limits.seats) {
    await auditDenied(tenantId, actorUserId, "org.invite", { reason: "seat_limit", seats: ent.plan.limits.seats, plan: ent.plan.id });
    throw new AppError("UPGRADE_REQUIRED", `The ${ent.plan.label} plan includes ${ent.plan.limits.seats} seats, and they're all used.`, { seats: ent.plan.limits.seats });
  }
}

/** Plan, limits and this month's usage, for the Billing page. */
export async function planSummary(input: { actorUserId: string; orgId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "billing.plan.read");
    const ent = await entitlementsIn(tx, input.orgId);
    const usage = await tx.select().from(usageCounters).where(eq(usageCounters.period, currentPeriod()));
    const [seats] = await tx.select({ n: sql<number>`count(*)::int` }).from(organizationMembers).where(eq(organizationMembers.tenantId, input.orgId));
    return {
      ...ent,
      period: currentPeriod(),
      seatsUsed: seats?.n ?? 0,
      usage: Object.fromEntries(METRICS.map((m) => [m, Number(usage.find((u) => u.metric === m)?.used ?? 0)])) as Record<Metric, number>,
    };
  });
}

/**
 * Maps a Stripe subscription to a plan. Unknown prices never grant anything.
 * STRIPE_PRICE_PLAN_MAP: JSON {"price_…": "scout_pro", …}.
 */
export function planForSubscription(status: string, priceId: string | null): { plan: string; reason: string } {
  const map = JSON.parse(process.env.STRIPE_PRICE_PLAN_MAP ?? "{}") as Record<string, string>;
  const mapped = priceId ? map[priceId] : undefined;
  if (!["active", "trialing", "past_due"].includes(status)) return { plan: BASE_PLAN, reason: `subscription ${status}` };
  if (!mapped || !planCatalog().some((p) => p.id === mapped)) return { plan: BASE_PLAN, reason: `price ${priceId ?? "none"} not mapped to a plan` };
  return { plan: mapped, reason: `subscription ${status}` };
}

/** Writes the plan inside a tenant transaction and audits a change. */
export async function applyPlan(tx: Tx, tenantId: string, plan: string, actor: { type: "system"; id: string }, reason: string): Promise<{ changed: boolean; from: string }> {
  const [org] = await tx.select({ plan: organizations.plan }).from(organizations).where(eq(organizations.id, tenantId));
  const from = planSpec(org?.plan).id;
  const to = planSpec(plan).id;
  if (from === to && org?.plan === to) return { changed: false, from };
  await tx.update(organizations).set({ plan: to }).where(and(eq(organizations.id, tenantId)));
  await recordAudit(tx, { tenantId, actorType: actor.type, actorId: actor.id, action: "billing.plan.change", target: `organization:${tenantId}`, tier: 3, outcome: "success", metadata: { from, to, reason } });
  logger.info({ tenantId, from, to, reason }, "plan changed");
  return { changed: from !== to, from };
}

/**
 * PLATFORM OPERATOR ONLY. Not exposed through the API. Used by seeds, tests
 * and support tooling to set a plan without Stripe (e.g. an enterprise contract).
 */
export async function operatorSetPlan(tenantId: string, plan: string, reason: string): Promise<void> {
  if (!planCatalog().some((p) => p.id === plan)) throw new Error(`unknown plan ${plan}`);
  await withTenant(tenantId, (tx) => applyPlan(tx, tenantId, plan, { type: "system", id: "operator" }, reason));
}
