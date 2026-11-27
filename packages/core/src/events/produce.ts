import { randomUUID } from "node:crypto";
import { MemoryJournal, runEvent, type EffectContext, type EventJournal } from "./bus";
import { rememberMockRetry } from "./retry";

/**
 * Another process is already making this exact provider call. Nothing was sent by
 * this caller. Try again shortly: by then the call has finished (a retry reads its
 * result back from the provider) or its lease has expired and the call can run.
 */
export class IntegrationBusyError extends Error {
  readonly code = "INTEGRATION_BUSY";
  constructor(readonly integration: string) {
    super(`A ${integration} call with this key is already in progress elsewhere`);
    this.name = "IntegrationBusyError";
  }
}

export type IntegrationName = "nws" | "spc" | "mail" | "crm" | "payments" | "model" | "sms";

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
  /** Idempotent mock retry. Stored only when `mock` is true and mock mode is on. */
  retry?: () => Promise<Record<string, unknown>>;
  /** True only when the provider itself is a mock. Live providers must pass false. */
  mock?: boolean;
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
  retry?: () => Promise<Record<string, unknown>>;
  mock?: boolean;
}): Promise<T> {
  if (opts.retry) rememberMockRetry(opts.tenantId, opts.idempotencyKey, opts.retry, opts.mock === true);
  let value: T | undefined;
  let failure: unknown;
  const inner = opts.journal ?? integrationJournal();
  // A later call with the same key must still be able to read the provider
  // (the provider dedupes). has() stays false so we don't drop the return value.
  const journal: EventJournal = {
    has: async () => false,
    put: (entry) => inner.put(entry),
    dead: (entry) => inner.dead(entry),
    // The claim is what stops two processes running the same provider call at once.
    ...(inner.claim && inner.finish ? { claim: (req) => inner.claim!(req), finish: (input) => inner.finish!(input) } : {}),
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
    // rereadCompleted: a repeat call with an already-applied key still reads the provider (it dedupes by key).
    { journal, maxAttempts: 1, timeoutMs: opts.timeoutMs, sleep: async () => undefined, rereadCompleted: true },
  );
  if (result.status === "busy") throw new IntegrationBusyError(opts.integration);
  if ((result.status === "done" || result.status === "duplicate") && value !== undefined) return value;
  if (failure) throw failure;
  throw new Error(result.reason ?? "integration_failed");
}

export function integrationKey(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}
