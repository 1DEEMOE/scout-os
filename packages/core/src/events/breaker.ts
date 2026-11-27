import { eq } from "drizzle-orm";
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
 * Two processes can race a half-open probe; the worst case is one extra
 * provider call per cool-down window, which is acceptable.
 */
export class DurableCircuitBreaker {
  constructor(private readonly opts: { threshold: number; coolDownMs: number } = { threshold: 3, coolDownMs: 30_000 }) {}

  /** Open/half-open rows for one tenant. The health endpoint uses this. */
  async snapshot(tenantId: string): Promise<{ name: string; state: Slot["state"] }[]> {
    return withTenant(tenantId, async (tx) =>
      tx.select({ name: integrationBreakers.name, state: integrationBreakers.state }).from(integrationBreakers),
    );
  }

  async reset(tenantId: string, name?: string): Promise<void> {
    await withTenant(tenantId, async (tx) => {
      if (name) await tx.delete(integrationBreakers).where(eq(integrationBreakers.name, name));
      else await tx.delete(integrationBreakers);
    });
  }

  private async save(tenantId: string, name: string, slot: Slot): Promise<void> {
    await withTenant(tenantId, (tx) =>
      tx
        .insert(integrationBreakers)
        .values({
          tenantId,
          name,
          state: slot.state,
          failures: slot.failures,
          openUntil: slot.openUntil ? new Date(slot.openUntil) : null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [integrationBreakers.tenantId, integrationBreakers.name],
          set: {
            state: slot.state,
            failures: slot.failures,
            openUntil: slot.openUntil ? new Date(slot.openUntil) : null,
            updatedAt: new Date(),
          },
        }),
    );
  }

  async run<T>(name: string, fn: () => Promise<T>, now = Date.now(), tenantId?: string): Promise<T> {
    if (!tenantId) throw new Error("DurableCircuitBreaker.run requires tenantId");
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(integrationBreakers).where(eq(integrationBreakers.name, name)),
    );
    let slot: Slot = row
      ? { failures: row.failures, state: row.state, openUntil: row.openUntil?.getTime() ?? 0 }
      : { failures: 0, state: "closed", openUntil: 0 };
    if (slot.state === "open") {
      if (now < slot.openUntil) throw new BreakerOpenError(name);
      slot = { ...slot, state: "half_open" };
      await this.save(tenantId, name, slot);
    }
    try {
      const value = await fn();
      await this.save(tenantId, name, { failures: 0, state: "closed", openUntil: 0 });
      return value;
    } catch (err) {
      const failures = slot.failures + 1;
      const open = failures >= this.opts.threshold || slot.state === "half_open";
      await this.save(tenantId, name, {
        failures,
        state: open ? "open" : "closed",
        openUntil: open ? now + this.opts.coolDownMs : 0,
      });
      throw err;
    }
  }
}

/** Either breaker implementation; the bus only relies on `run`. */
export type SharedBreaker = Pick<CircuitBreaker, "run"> | Pick<DurableCircuitBreaker, "run">;

/** Shared breaker for outbound integrations in this process. */
export const integrations = new CircuitBreaker();
