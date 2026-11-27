import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { integrationBreakers, withTenant } from "@wos/db";

export class BreakerOpenError extends Error {
  readonly code = "BREAKER_OPEN";
  constructor(readonly integration: string) {
    super(`Integration ${integration} is paused after repeated failures`);
    this.name = "BreakerOpenError";
  }
}

interface Slot {
  failures: number;
  state: "closed" | "open" | "half_open";
  openUntil: number;
}

/** Process-local circuit breaker. Tests and mock runs use this. */
export class CircuitBreaker {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly opts: { threshold: number; coolDownMs: number } = { threshold: 3, coolDownMs: 30_000 }) {}

  snapshot(): { name: string; state: Slot["state"] }[] {
    return [...this.slots.entries()].map(([name, slot]) => ({ name, state: slot.state }));
  }

  reset(name?: string): void {
    if (name) this.slots.delete(name);
    else this.slots.clear();
  }

  async run<T>(name: string, fn: () => Promise<T>, now = Date.now(), _tenantId?: string): Promise<T> {
    const slot = this.slots.get(name) ?? { failures: 0, state: "closed" as const, openUntil: 0 };
    if (slot.state === "open") {
      if (now < slot.openUntil) throw new BreakerOpenError(name);
      slot.state = "half_open";
      this.slots.set(name, slot);
    }
    try {
      const value = await fn();
      this.slots.set(name, { failures: 0, state: "closed", openUntil: 0 });
      return value;
    } catch (err) {
      const failures = slot.failures + 1;
      const open = failures >= this.opts.threshold || slot.state === "half_open";
      this.slots.set(name, {
        failures,
        state: open ? "open" : "closed",
        openUntil: open ? now + this.opts.coolDownMs : 0,
      });
      throw err;
    }
  }
}

/**
 * Durable breaker (migration 0022): state lives in `integration_breakers`, so
 * an integration that starts failing is paused for every web and worker
 * process, not just the one that saw the failures. Rows are per tenant —
 * one workspace's failing Gmail does not pause another workspace's.
 *
 * Every state change is a single SQL statement, so two processes cannot
 * overwrite each other's update (no read-modify-write in application code):
 *  - a failure is one upsert that increments `failures` and decides open/closed
 *    from the row's own current values;
 *  - after the cool-down, one caller claims the half-open probe with a
 *    conditional UPDATE ... RETURNING and the others are refused. The claim
 *    also sets `open_until` to the end of a probe lease, so a probe whose
 *    process died is retaken once the lease runs out instead of wedging the
 *    breaker half-open forever;
 *  - reset() is an UPDATE back to closed (app_user has no DELETE grant).
 */
export class DurableCircuitBreaker {
  constructor(private readonly opts: { threshold: number; coolDownMs: number } = { threshold: 3, coolDownMs: 30_000 }) {}

  /** Breaker rows for one tenant (closed ones included). */
  async snapshot(tenantId: string): Promise<{ name: string; state: Slot["state"] }[]> {
    return withTenant(tenantId, async (tx) =>
      tx.select({ name: integrationBreakers.name, state: integrationBreakers.state }).from(integrationBreakers),
    );
  }

  /** Closes one breaker, or all of the tenant's when no name is given. */
  async reset(tenantId: string, name?: string): Promise<void> {
    await withTenant(tenantId, async (tx) => {
      const closed = { state: "closed" as const, failures: 0, openUntil: null, updatedAt: new Date() };
      if (name) await tx.update(integrationBreakers).set(closed).where(eq(integrationBreakers.name, name));
      else await tx.update(integrationBreakers).set(closed);
    });
  }

  /** Success: closed, count cleared. One upsert. */
  private async recordSuccess(tenantId: string, name: string): Promise<void> {
    const closed = { state: "closed" as const, failures: 0, openUntil: null, updatedAt: new Date() };
    await withTenant(tenantId, (tx) =>
      tx
        .insert(integrationBreakers)
        .values({ tenantId, name, ...closed })
        .onConflictDoUpdate({ target: [integrationBreakers.tenantId, integrationBreakers.name], set: closed }),
    );
  }

  /**
   * Failure: increment and decide in one statement. The row opens when this
   * failure reaches the threshold or when it was a half-open probe.
   */
  private async recordFailure(tenantId: string, name: string, now: number): Promise<void> {
    const { threshold, coolDownMs } = this.opts;
    const reopenAt = new Date(now + coolDownMs);
    const opens = sql`(${integrationBreakers.failures} + 1 >= ${threshold} OR ${integrationBreakers.state} = 'half_open')`;
    const firstOpens = threshold <= 1;
    await withTenant(tenantId, (tx) =>
      tx
        .insert(integrationBreakers)
        .values({
          tenantId,
          name,
          failures: 1,
          state: firstOpens ? "open" : "closed",
          openUntil: firstOpens ? reopenAt : null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [integrationBreakers.tenantId, integrationBreakers.name],
          set: {
            failures: sql`${integrationBreakers.failures} + 1`,
            state: sql`CASE WHEN ${opens} THEN 'open' ELSE 'closed' END`,
            openUntil: sql`CASE WHEN ${opens} THEN ${reopenAt}::timestamptz ELSE NULL END`,
            updatedAt: new Date(),
          },
        }),
    );
  }

  /**
   * Takes the single half-open probe slot. True for exactly one caller: the
   * row must still be open (or a half-open whose lease has expired) at the
   * moment of the UPDATE, so a second caller's UPDATE matches nothing.
   */
  private async claimProbe(tenantId: string, name: string, now: number): Promise<boolean> {
    const at = new Date(now);
    const claimed = await withTenant(tenantId, (tx) =>
      tx
        .update(integrationBreakers)
        .set({ state: "half_open", openUntil: new Date(now + this.opts.coolDownMs), updatedAt: new Date() })
        .where(
          and(
            eq(integrationBreakers.name, name),
            inArray(integrationBreakers.state, ["open", "half_open"]),
            or(isNull(integrationBreakers.openUntil), lte(integrationBreakers.openUntil, at)),
          ),
        )
        .returning({ id: integrationBreakers.id }),
    );
    return claimed.length === 1;
  }

  async run<T>(name: string, fn: () => Promise<T>, now = Date.now(), tenantId?: string): Promise<T> {
    if (!tenantId) throw new Error("DurableCircuitBreaker.run requires tenantId");
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(integrationBreakers).where(eq(integrationBreakers.name, name)),
    );
    if (row && (row.state === "open" || row.state === "half_open")) {
      // Still cooling down, or another caller's probe lease is running.
      if (row.openUntil && now < row.openUntil.getTime()) throw new BreakerOpenError(name);
      // Cool-down over: exactly one caller becomes the probe.
      if (!(await this.claimProbe(tenantId, name, now))) throw new BreakerOpenError(name);
    }
    try {
      const value = await fn();
      await this.recordSuccess(tenantId, name);
      return value;
    } catch (err) {
      await this.recordFailure(tenantId, name, now);
      throw err;
    }
  }
}

/** Either breaker implementation; the bus only relies on `run`. */
export type SharedBreaker = Pick<CircuitBreaker, "run"> | Pick<DurableCircuitBreaker, "run">;

/** Shared breaker for outbound integrations in this process. */
export const integrations = new CircuitBreaker();
