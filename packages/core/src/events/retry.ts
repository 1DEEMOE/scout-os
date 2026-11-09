import { effectWasApplied } from "./bus";

interface MockRetry {
  fn: () => Promise<Record<string, unknown>>;
  mock: true;
}

const retries = new Map<string, MockRetry>();

/**
 * Stores an idempotent retry only for a mock provider while mock mode is on.
 * A live provider is not stored here. Replay of a live failure stays on the
 * approval-gated tool path and is not run from this map.
 */
export function rememberMockRetry(tenantId: string, key: string, fn: () => Promise<Record<string, unknown>>, mock: boolean): void {
  if (!mock || process.env.WOS_MOCK_MODE !== "1") return;
  retries.set(`${tenantId}:${key}`, { fn, mock: true });
}

export function resetMockRetries(): void {
  retries.clear();
}

export async function runMockRetry(tenantId: string, key: string): Promise<Record<string, unknown> | null> {
  if (effectWasApplied(tenantId, key)) return { ok: true, duplicate: true, retried: false, mock: false };
  const entry = retries.get(`${tenantId}:${key}`);
  if (!entry || process.env.WOS_MOCK_MODE !== "1") return null;
  const value = await entry.fn();
  retries.delete(`${tenantId}:${key}`);
  return { ...value, ok: true, retried: true, mock: true };
}
