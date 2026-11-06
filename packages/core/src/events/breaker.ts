/** Process-local circuit breaker. A second worker does not see this state until proposed 0022 is adopted. */

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

  async run<T>(name: string, fn: () => Promise<T>, now = Date.now()): Promise<T> {
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

/** Shared breaker for outbound integrations in this process. */
export const integrations = new CircuitBreaker();
