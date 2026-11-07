import { randomUUID } from "node:crypto";
import { MemoryJournal, runEvent, type EffectContext, type EventJournal } from "./bus";

export type IntegrationName = "nws" | "mail" | "crm" | "payments" | "model";

const fallbackJournal = new MemoryJournal();
let journalOverride: EventJournal | undefined;
const inflightProduce = new Map<string, Promise<unknown>>();

/** Production sets the audit journal. Tests can install a memory journal. */
export function setIntegrationJournal(journal: EventJournal | undefined): void {
  journalOverride = journal;
}

export function integrationJournal(): EventJournal {
  return journalOverride ?? fallbackJournal;
}

/**
 * Runs one already-authorized provider call through the bus.
 * Tier stays 0: the caller passed the approval gate before this.
 * A failure is dead-lettered for Recovery. The effect checks its idempotency key via ctx.once.
 */
export function produceIntegration<T>(opts: {
  tenantId: string;
  integration: IntegrationName;
  idempotencyKey: string;
  effect: (ctx: EffectContext) => Promise<T>;
  journal?: EventJournal;
  timeoutMs?: number;
}): Promise<T> {
  const id = `${opts.tenantId}:${opts.idempotencyKey}`;
  const existing = inflightProduce.get(id);
  if (existing) return existing as Promise<T>;
  const promise = runProduce<T>(opts).finally(() => inflightProduce.delete(id));
  inflightProduce.set(id, promise);
  return promise;
}

async function runProduce<T>(opts: {
  tenantId: string;
  integration: IntegrationName;
  idempotencyKey: string;
  effect: (ctx: EffectContext) => Promise<T>;
  journal?: EventJournal;
  timeoutMs?: number;
}): Promise<T> {
  let value: T | undefined;
  let failure: unknown;
  const inner = opts.journal ?? integrationJournal();
  // A later call with the same key must still be able to read the provider
  // (the provider dedupes). has() stays false so we don't drop the return value.
  const journal = {
    has: async () => false,
    put: (entry: Parameters<EventJournal["put"]>[0]) => inner.put(entry),
    dead: (entry: Parameters<EventJournal["dead"]>[0]) => inner.dead(entry),
  };
  const result = await runEvent(
    {
      tenantId: opts.tenantId,
      idempotencyKey: opts.idempotencyKey,
      type: `integration.${opts.integration}`,
      source: opts.integration,
      integration: opts.integration,
    },
    {
      type: `integration.${opts.integration}`,
      maxTier: 0,
      decide: () => ({ act: true, reason: opts.integration }),
      act: async (_event, ctx) => {
        try {
          value = await opts.effect(ctx);
          return { ok: true };
        } catch (err) {
          failure = err;
          throw err;
        }
      },
    },
    { journal, maxAttempts: 1, timeoutMs: opts.timeoutMs, sleep: async () => undefined },
  );
  if ((result.status === "done" || result.status === "duplicate") && value !== undefined) return value;
  if (failure) throw failure;
  throw new Error(result.reason ?? "integration_failed");
}

export function integrationKey(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}
