import { BreakerOpenError, integrations, type CircuitBreaker } from "./breaker";
import { logOp } from "./correlation";

/**
 * Deterministic pipeline: detect → decide → act → verify → log.
 * Handlers are code, not model output, and may only be tier 0 or 1.
 * Sending email, SMS, or money is not a bus action.
 */

export interface BusEvent {
  tenantId: string;
  idempotencyKey: string;
  type: string;
  source: string;
  integration?: string;
  payload?: Record<string, string | number | boolean | null>;
}

export interface BusHandler {
  type: string;
  /** Refused unless this is 0 or 1. Email, chat sends, and payments are not bus work. */
  maxTier: number;
  decide(event: BusEvent): { act: boolean; reason: string };
  act(event: BusEvent): Promise<Record<string, unknown>>;
  verify?(event: BusEvent, result: Record<string, unknown>): boolean;
}

export interface JournalEntry {
  tenantId: string;
  key: string;
  type: string;
  source: string;
  attempt: number;
}

export interface DeadLetter {
  tenantId: string;
  key: string;
  type: string;
  source: string;
  integration?: string;
  error: string;
  attempts: number;
}

export interface EventJournal {
  has(tenantId: string, key: string): Promise<boolean>;
  put(entry: JournalEntry): Promise<"inserted" | "duplicate">;
  dead(entry: DeadLetter): Promise<void>;
}

export class MemoryJournal implements EventJournal {
  readonly done = new Set<string>();
  readonly deadLetters: DeadLetter[] = [];

  async has(tenantId: string, key: string): Promise<boolean> {
    return this.done.has(`${tenantId}:${key}`);
  }

  async put(entry: JournalEntry): Promise<"inserted" | "duplicate"> {
    const id = `${entry.tenantId}:${entry.key}`;
    if (this.done.has(id)) return "duplicate";
    this.done.add(id);
    return "inserted";
  }

  async dead(entry: DeadLetter): Promise<void> {
    this.deadLetters.push(entry);
  }
}

export type EventStatus = "done" | "duplicate" | "skipped" | "dead" | "degraded" | "rejected";

export interface EventResult {
  status: EventStatus;
  reason?: string;
  attempt?: number;
  result?: Record<string, unknown>;
}

const inflight = new Map<string, Promise<EventResult>>();

export function backoffMs(attempt: number): number {
  return Math.min(30_000, 50 * 2 ** (attempt - 1));
}

export async function runEvent(
  event: BusEvent,
  handler: BusHandler,
  deps: {
    journal: EventJournal;
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
    breaker?: CircuitBreaker;
    timeoutMs?: number;
  },
): Promise<EventResult> {
  const id = `${event.tenantId}:${event.idempotencyKey}`;
  const existing = inflight.get(id);
  if (existing) return existing;
  const promise = runEventInner(event, handler, deps).finally(() => inflight.delete(id));
  inflight.set(id, promise);
  return promise;
}

async function runEventInner(
  event: BusEvent,
  handler: BusHandler,
  deps: {
    journal: EventJournal;
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
    breaker?: CircuitBreaker;
    timeoutMs?: number;
  },
): Promise<EventResult> {
  const started = Date.now();
  if (handler.maxTier !== 0 && handler.maxTier !== 1) {
    logOp({ message: "event rejected", tenantId: event.tenantId, tool: event.type, input: event.idempotencyKey, outcome: "denied", failure: "handler_tier", durationMs: Date.now() - started });
    return { status: "rejected", reason: "handler_tier" };
  }
  if (handler.type !== event.type) return { status: "rejected", reason: "type_mismatch" };
  if (await deps.journal.has(event.tenantId, event.idempotencyKey)) return { status: "duplicate" };

  const decision = handler.decide(event);
  if (!decision.act) {
    await deps.journal.put({ tenantId: event.tenantId, key: event.idempotencyKey, type: event.type, source: event.source, attempt: 0 });
    logOp({ message: "event skipped", tenantId: event.tenantId, tool: event.type, input: event.idempotencyKey, outcome: "success", output: decision.reason, durationMs: Date.now() - started });
    return { status: "skipped", reason: decision.reason };
  }

  const maxAttempts = deps.maxAttempts ?? 3;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const breaker = deps.breaker ?? integrations;
  let lastError = "unknown";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const act = () => withTimeout(handler.act(event), deps.timeoutMs ?? 8_000);
      const result = event.integration ? await breaker.run(event.integration, act) : await act();
      if (handler.verify && !handler.verify(event, result)) throw new Error("verify_failed");
      const wrote = await deps.journal.put({ tenantId: event.tenantId, key: event.idempotencyKey, type: event.type, source: event.source, attempt });
      if (wrote === "duplicate") return { status: "duplicate" };
      logOp({ message: "event done", tenantId: event.tenantId, tool: event.type, input: event.idempotencyKey, outcome: "success", output: "verified", durationMs: Date.now() - started, recovery: attempt > 1 ? `attempt ${attempt}` : undefined });
      return { status: "done", attempt, result };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof BreakerOpenError) {
        await deps.journal.dead({ tenantId: event.tenantId, key: event.idempotencyKey, type: event.type, source: event.source, integration: event.integration, error: "breaker_open", attempts: attempt });
        logOp({ message: "event degraded", tenantId: event.tenantId, tool: event.type, input: event.idempotencyKey, outcome: "degraded", failure: lastError, durationMs: Date.now() - started, recovery: "dead_letter" });
        return { status: "degraded", reason: "breaker_open", attempt };
      }
      if (attempt < maxAttempts) await sleep(backoffMs(attempt));
    }
  }
  await deps.journal.dead({ tenantId: event.tenantId, key: event.idempotencyKey, type: event.type, source: event.source, integration: event.integration, error: lastError.slice(0, 200), attempts: maxAttempts });
  logOp({ message: "event dead", tenantId: event.tenantId, tool: event.type, input: event.idempotencyKey, outcome: "error", failure: lastError, durationMs: Date.now() - started, recovery: "dead_letter" });
  return { status: "dead", reason: lastError, attempt: maxAttempts };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
