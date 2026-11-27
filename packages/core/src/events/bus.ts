import { randomUUID } from "node:crypto";
import { scrubPii } from "../logger";
import { BreakerOpenError, integrations, type SharedBreaker } from "./breaker";

/** Process-wide default breaker. Production installs the durable breaker so
 * every web/worker process shares open state; tests keep the in-process one. */
let defaultBreaker: SharedBreaker = integrations;
export function setIntegrationBreaker(breaker: SharedBreaker | undefined): void {
  defaultBreaker = breaker ?? integrations;
}
import { logOp } from "./correlation";

export function safeErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const scrubbed = scrubPii(raw);
  return (typeof scrubbed === "string" ? scrubbed : "error").slice(0, 200);
}

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

export interface EffectContext {
  signal: AbortSignal;
  /** Runs fn at most once for this event key. A late or overlapping attempt does not call fn again. */
  once<T>(fn: () => Promise<T>): Promise<T>;
}

export interface BusHandler {
  type: string;
  /** Refused unless this is 0 or 1. Email, chat sends, and payments are not bus work. */
  maxTier: number;
  decide(event: BusEvent): { act: boolean; reason: string };
  act(event: BusEvent, ctx: EffectContext): Promise<Record<string, unknown>>;
  verify?(event: BusEvent, result: Record<string, unknown>): boolean;
}

export interface JournalEntry {
  tenantId: string;
  key: string;
  type: string;
  source: string;
  attempt: number;
  /** Recorded by the durable journal; memory journals ignore it. */
  status?: "done" | "skipped";
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

/**
 * Outcome of asking to run an event's effect.
 *  - claimed:   this caller holds the lease and must run the effect;
 *  - completed: the event already finished (done, skipped or dead);
 *  - busy:      another caller holds a live lease on it right now.
 */
export type ClaimResult = "claimed" | "completed" | "busy";

export interface ClaimRequest {
  tenantId: string;
  key: string;
  type: string;
  source: string;
  /** Random per run. Only the owner can finish the claim it holds. */
  owner: string;
  /** How long the lease lasts. After it passes, another caller may take over. */
  leaseMs: number;
}

export interface EventJournal {
  has(tenantId: string, key: string): Promise<boolean>;
  put(entry: JournalEntry): Promise<"inserted" | "duplicate">;
  dead(entry: DeadLetter): Promise<void>;
  /**
   * Optional. Journals shared across processes implement it so two workers
   * (or a redelivered job, or a replay) cannot run the same effect at once.
   * The claim is one atomic statement in the store, not in-process state.
   */
  claim?(req: ClaimRequest): Promise<ClaimResult>;
  /**
   * Optional, paired with claim. Ends the claim the owner holds: 'done' records
   * the event as applied, 'failed' makes the key claimable again. False means the
   * lease was lost (it expired and someone else took over), so the caller must
   * not treat its result as the recorded one.
   */
  finish?(input: { tenantId: string; key: string; owner: string; outcome: "done" | "failed"; attempt: number }): Promise<boolean>;
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

/** "busy": another process is running this event now. It is neither done nor failed; try again later. */
export type EventStatus = "done" | "duplicate" | "skipped" | "dead" | "degraded" | "rejected" | "busy";

export interface EventResult {
  status: EventStatus;
  reason?: string;
  attempt?: number;
  result?: Record<string, unknown>;
}

const inflight = new Map<string, Promise<EventResult>>();

/** Successful effects, shared by every runEvent in this process. A replay of an applied key does not run the effect again. */
const appliedEffects = new Map<string, Promise<unknown>>();
/** In-flight effects. A replay that arrives before the first attempt finishes waits on this instead of starting another. */
const inflightEffects = new Map<string, Promise<unknown>>();

export function resetAppliedEffects(): void {
  appliedEffects.clear();
  inflightEffects.clear();
}

export function effectWasApplied(tenantId: string, key: string): boolean {
  return appliedEffects.has(`${tenantId}:${key}`);
}

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
    breaker?: SharedBreaker;
    timeoutMs?: number;
    /**
     * With a claiming journal, an event that already completed is normally dropped.
     * Set this when the caller must still run the effect to read its result back
     * (the provider dedupes by key). The effect then runs without taking a lease.
     */
    rereadCompleted?: boolean;
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
    breaker?: SharedBreaker;
    timeoutMs?: number;
    /**
     * With a claiming journal, an event that already completed is normally dropped.
     * Set this when the caller must still run the effect to read its result back
     * (the provider dedupes by key). The effect then runs without taking a lease.
     */
    rereadCompleted?: boolean;
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
    await deps.journal.put({ tenantId: event.tenantId, key: event.idempotencyKey, type: event.type, source: event.source, attempt: 0, status: "skipped" });
    logOp({ message: "event skipped", tenantId: event.tenantId, tool: event.type, input: event.idempotencyKey, outcome: "success", output: decision.reason, durationMs: Date.now() - started });
    return { status: "skipped", reason: decision.reason };
  }

  const maxAttempts = deps.maxAttempts ?? 3;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const breaker = deps.breaker ?? defaultBreaker;
  const timeoutMs = deps.timeoutMs ?? 8_000;

  // Claim before the effect. The in-process maps above only stop duplicates inside one
  // process; the claim is an atomic write in the shared store, so a second worker, a
  // redelivered job or a replay cannot start the same effect while this one runs.
  const owner = randomUUID();
  let leased = false;
  let rereadOnly = false;
  if (deps.journal.claim) {
    // Longest this run can legitimately take: every attempt at its time cap plus the longest backoff.
    const leaseMs = maxAttempts * (timeoutMs + 30_000);
    const claim = await deps.journal.claim({ tenantId: event.tenantId, key: event.idempotencyKey, type: event.type, source: event.source, owner, leaseMs });
    if (claim === "busy") {
      logOp({ message: "event busy", tenantId: event.tenantId, tool: event.type, input: event.idempotencyKey, outcome: "degraded", failure: "in_progress_elsewhere", durationMs: Date.now() - started, recovery: "retry_later" });
      return { status: "busy", reason: "in_progress" };
    }
    if (claim === "completed") {
      if (!deps.rereadCompleted) return { status: "duplicate" };
      rereadOnly = true;
    } else {
      leased = true;
    }
  }
  /** Gives the key back so it can be claimed again. Not used after a timeout: the effect may still be running. */
  let released = false;
  const release = async (attempt: number) => {
    if (!leased || released || !deps.journal.finish) return;
    released = true;
    await deps.journal.finish({ tenantId: event.tenantId, key: event.idempotencyKey, owner, outcome: "failed", attempt });
  };

  let lastError = "unknown";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const act = () => withTimeout((signal) => handler.act(event, effectContext(event.tenantId, event.idempotencyKey, signal)), timeoutMs);
      const result = event.integration ? await breaker.run(event.integration, act, Date.now(), event.tenantId) : await act();
      if (handler.verify && !handler.verify(event, result)) throw new Error("verify_failed");
      let wrote: "inserted" | "duplicate";
      if (leased && deps.journal.finish) {
        const kept = await deps.journal.finish({ tenantId: event.tenantId, key: event.idempotencyKey, owner, outcome: "done", attempt });
        released = true;
        wrote = kept ? "inserted" : "duplicate"; // false: the lease ran out and another worker took the key
      } else if (rereadOnly) {
        wrote = "duplicate"; // already recorded by an earlier run; this one only read the result back
      } else {
        wrote = await deps.journal.put({ tenantId: event.tenantId, key: event.idempotencyKey, type: event.type, source: event.source, attempt, status: "done" });
      }
      if (wrote === "duplicate") return { status: "duplicate" };
      logOp({ message: "event done", tenantId: event.tenantId, tool: event.type, input: event.idempotencyKey, outcome: "success", output: "verified", durationMs: Date.now() - started, recovery: attempt > 1 ? `attempt ${attempt}` : undefined });
      return { status: "done", attempt, result };
    } catch (err) {
      lastError = safeErrorText(err);
      if (err instanceof BreakerOpenError) {
        await release(attempt); // the effect never started
        await deps.journal.dead({ tenantId: event.tenantId, key: event.idempotencyKey, type: event.type, source: event.source, integration: event.integration, error: "breaker_open", attempts: attempt });
        logOp({ message: "event degraded", tenantId: event.tenantId, tool: event.type, input: event.idempotencyKey, outcome: "degraded", failure: "breaker_open", durationMs: Date.now() - started, recovery: "dead_letter" });
        return { status: "degraded", reason: "breaker_open", attempt };
      }
      // A timeout means the effect may still be finishing. Do not start another attempt,
      // and keep the lease: a replay is refused until it expires, so it cannot overlap.
      if (isTimeout(err)) {
        await deps.journal.dead({ tenantId: event.tenantId, key: event.idempotencyKey, type: event.type, source: event.source, integration: event.integration, error: "timeout", attempts: attempt });
        logOp({ message: "event timed out", tenantId: event.tenantId, tool: event.type, input: event.idempotencyKey, outcome: "error", failure: "timeout", durationMs: Date.now() - started, recovery: "dead_letter" });
        return { status: "dead", reason: "timeout", attempt };
      }
      if (attempt < maxAttempts) await sleep(backoffMs(attempt));
    }
  }
  await release(maxAttempts);
  await deps.journal.dead({ tenantId: event.tenantId, key: event.idempotencyKey, type: event.type, source: event.source, integration: event.integration, error: lastError, attempts: maxAttempts });
  logOp({ message: "event dead", tenantId: event.tenantId, tool: event.type, input: event.idempotencyKey, outcome: "error", failure: lastError, durationMs: Date.now() - started, recovery: "dead_letter" });
  return { status: "dead", reason: lastError, attempt: maxAttempts };
}

function effectContext(tenantId: string, key: string, signal: AbortSignal): EffectContext {
  const id = `${tenantId}:${key}`;
  return {
    signal,
    once: (fn) => {
      const prior = appliedEffects.get(id);
      if (prior) return prior as Promise<Awaited<ReturnType<typeof fn>>>;
      const running = inflightEffects.get(id);
      if (running) return running as Promise<Awaited<ReturnType<typeof fn>>>;
      if (signal.aborted) return Promise.reject(abortError());
      const pending = Promise.resolve()
        .then(() => {
          if (signal.aborted) throw abortError();
          return fn();
        })
        .then(
          (value) => {
            appliedEffects.set(id, Promise.resolve(value));
            inflightEffects.delete(id);
            return value;
          },
          (err) => {
            inflightEffects.delete(id);
            throw err;
          },
        );
      inflightEffects.set(id, pending);
      return pending;
    },
  };
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function isTimeout(err: unknown): boolean {
  if (err instanceof Error && (err.name === "AbortError" || err.message === "timeout" || err.message === "aborted")) return true;
  return false;
}

function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, ms);
    fn(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        controller.abort();
        reject(err);
      },
    );
  });
}
