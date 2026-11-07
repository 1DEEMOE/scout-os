import { effectWasApplied } from "./bus";

const retries = new Map<string, () => Promise<Record<string, unknown>>>();

/** Stores an idempotent mock retry for a failed provider call. Replay runs it at most once. */
export function rememberMockRetry(tenantId: string, key: string, fn: () => Promise<Record<string, unknown>>): void {
  retries.set(`${tenantId}:${key}`, fn);
}

export function resetMockRetries(): void {
  retries.clear();
}

export async function runMockRetry(tenantId: string, key: string): Promise<Record<string, unknown> | null> {
  if (effectWasApplied(tenantId, key)) return { ok: true, duplicate: true };
  const fn = retries.get(`${tenantId}:${key}`);
  if (!fn) return null;
  const value = await fn();
  retries.delete(`${tenantId}:${key}`);
  return { ok: true, retried: true, mock: true, ...value };
}
