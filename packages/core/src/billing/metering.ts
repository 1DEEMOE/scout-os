import { and, eq, gte, sql, sum } from "drizzle-orm";
import { z } from "zod";
import { billingLedger, organizations, usageEvents, withTenant } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import type { ModelRequest, ModelResponse } from "../engine/router";
import { ANY_ROLE, inOrg, requireRole } from "../org/access";

/**
 * Per-token prices in USD per million tokens. These are CONFIGURATION, not
 * facts: set them from your model provider's current price list
 * (MODEL_PRICE_INPUT_USD_PER_MTOK / MODEL_PRICE_OUTPUT_USD_PER_MTOK).
 * 1 USD per million tokens = 1 micro-dollar per token.
 */
export function modelPrices(): { input: number; output: number } {
  return {
    input: Number(process.env.MODEL_PRICE_INPUT_USD_PER_MTOK ?? 3),
    output: Number(process.env.MODEL_PRICE_OUTPUT_USD_PER_MTOK ?? 15),
  };
}

export function costMicros(res: Pick<ModelResponse, "usage" | "provider">): number {
  if (res.provider === "mock" || res.provider === "direct") return 0;
  const p = modelPrices();
  return Math.ceil(res.usage.inputTokens * p.input + res.usage.outputTokens * p.output);
}

export const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export const periodOf = (d = new Date()) => d.toISOString().slice(0, 7);

export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED";
  constructor(spent: number, budget: number) {
    super(`This month's AI budget is used up ($${(spent / 1e6).toFixed(2)} of $${(budget / 1e6).toFixed(2)}). An owner can raise it in Billing.`);
    this.name = "BudgetExceededError";
  }
}

/**
 * Soft reservation for one model call, in micro-dollars. Concurrent callers
 * reserve against the monthly budget before the provider is contacted so they
 * cannot all slip through a check-then-act race (E-3). Settled to the real
 * cost in recordModelUsage. Override with MODEL_CALL_RESERVE_MICROS.
 */
export function modelCallReserveMicros(): number {
  const n = Number(process.env.MODEL_CALL_RESERVE_MICROS ?? 25_000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 25_000;
}

/** Per-request reservation amount, settled in afterCall. */
const reservations = new WeakMap<ModelRequest, { period: string; reserved: number }>();

/** Router hook: refuses the call before it is made if the month's budget is spent. */
export async function assertWithinBudget(req: ModelRequest): Promise<void> {
  const estimate = modelCallReserveMicros();
  const period = periodOf();
  const result = await withTenant(req.tenantId, async (tx) => {
    const [org] = await tx.select({ budget: organizations.monthlyAiBudgetMicros }).from(organizations).where(eq(organizations.id, req.tenantId));
    const budget = org?.budget ?? 0;
    // Reserve up to the remaining budget so a single call whose real cost is
    // slightly above the budget can still finish (existing metering contract),
    // while parallel callers cannot each reserve the full amount.
    const toReserve = Math.min(estimate, Math.max(budget, 1));
    const rows = await tx.execute(sql`
      INSERT INTO usage_counters (tenant_id, metric, period, used)
      VALUES (${req.tenantId}, 'ai_cost_micros', ${period}, ${toReserve})
      ON CONFLICT (tenant_id, metric, period)
      DO UPDATE SET used = usage_counters.used + EXCLUDED.used, updated_at = now()
      WHERE usage_counters.used + EXCLUDED.used <= ${budget}
      RETURNING used`);
    const row = rows.rows[0] as { used: number } | undefined;
    if (!row) {
      const cur = await tx.execute(sql`
        SELECT coalesce(used, 0)::bigint AS used
        FROM usage_counters
        WHERE tenant_id = ${req.tenantId} AND metric = 'ai_cost_micros' AND period = ${period}`);
      const spent = Number((cur.rows[0] as { used: number } | undefined)?.used ?? 0);
      return { ok: false as const, spent, budget };
    }
    return { ok: true as const, reserved: toReserve, period, spent: Number(row.used), budget };
  });
  if (!result.ok) throw new BudgetExceededError(result.spent, result.budget);
  reservations.set(req, { period: result.period, reserved: result.reserved });
}

/** Router hook: records what the call used and settles the reservation. */
export async function recordModelUsage(req: ModelRequest, res: ModelResponse): Promise<void> {
  const cost = costMicros(res);
  const reservation = reservations.get(req);
  reservations.delete(req);
  await withTenant(req.tenantId, async (tx) => {
    await tx.insert(usageEvents).values({
      tenantId: req.tenantId,
      taskId: req.taskId ?? null,
      agentId: req.agentId ?? null,
      kind: "model_tokens",
      quantity: res.usage.inputTokens + res.usage.outputTokens,
      costMicros: cost,
      provider: res.provider,
      model: res.model,
      purpose: req.purpose,
    });
    if (!reservation) return;
    // Replace the soft reservation with the real cost (may be 0 for mock).
    const delta = cost - reservation.reserved;
    await tx.execute(sql`
      UPDATE usage_counters
      SET used = GREATEST(0, used + ${delta}), updated_at = now()
      WHERE tenant_id = ${req.tenantId} AND metric = 'ai_cost_micros' AND period = ${reservation.period}`);
  });
}

export const meteringHooks = { beforeCall: assertWithinBudget, afterCall: recordModelUsage };

export async function usageSummary(input: { actorUserId: string; orgId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "usage.read");
    const since = monthStart();
    const [org] = await tx.select({ budget: organizations.monthlyAiBudgetMicros }).from(organizations).where(eq(organizations.id, input.orgId));
    const byKind = await tx
      .select({ kind: usageEvents.kind, quantity: sum(usageEvents.quantity), cost: sum(usageEvents.costMicros), calls: sql<number>`count(*)::int` })
      .from(usageEvents)
      .where(gte(usageEvents.at, since))
      .groupBy(usageEvents.kind);
    const byAgent = await tx
      .select({ agentId: usageEvents.agentId, cost: sum(usageEvents.costMicros), calls: sql<number>`count(*)::int` })
      .from(usageEvents)
      .where(and(gte(usageEvents.at, since), eq(usageEvents.kind, "model_tokens")))
      .groupBy(usageEvents.agentId);
    const spent = byKind.reduce((s, k) => s + Number(k.cost ?? 0), 0);
    return {
      period: periodOf(),
      budgetMicros: org!.budget,
      spentMicros: spent,
      byKind: byKind.map((k) => ({ kind: k.kind, quantity: Number(k.quantity ?? 0), costMicros: Number(k.cost ?? 0), calls: k.calls })),
      byAgent: byAgent.map((a) => ({ agentId: a.agentId, costMicros: Number(a.cost ?? 0), calls: a.calls })),
    };
  });
}

/** Changing the AI budget is a financial setting: owners only, audited. */
export async function setMonthlyBudget(input: { actorUserId: string; orgId: string; budgetCents: number }) {
  const cents = z.number().int().min(0).max(1_000_000).parse(input.budgetCents);
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ["owner"], "billing.set_budget");
    await tx.update(organizations).set({ monthlyAiBudgetMicros: cents * 10_000 }).where(eq(organizations.id, input.orgId));
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "billing.set_budget", tier: 3, outcome: "success", metadata: { budgetCents: cents } });
    return { budgetMicros: cents * 10_000 };
  });
}

/**
 * Writes one ledger entry with the month's total usage cost. Safe to run more
 * than once: the ledger allows a single usage entry per tenant and month.
 */
export async function closeUsagePeriod(tenantId: string, period: string): Promise<{ amountMicros: number; created: boolean }> {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new AppError("VALIDATION", "Period must be YYYY-MM");
  const start = new Date(`${period}-01T00:00:00Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.select({ total: sum(usageEvents.costMicros) }).from(usageEvents).where(and(gte(usageEvents.at, start), sql`${usageEvents.at} < ${end}`));
    const amountMicros = Number(row?.total ?? 0);
    const inserted = await tx.insert(billingLedger).values({ tenantId, entryType: "usage", amountMicros, period }).onConflictDoNothing().returning({ id: billingLedger.id });
    return { amountMicros, created: inserted.length > 0 };
  });
}
