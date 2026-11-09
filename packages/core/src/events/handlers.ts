import { fetchNwsAlerts } from "../speed/nws";
import { registerBusHandler } from "./recovery";
import { effectWasApplied } from "./bus";
import { runMockRetry } from "./retry";

/** Event types produceIntegration writes. Replay must register each of these. */
export const PRODUCER_EVENT_TYPES = ["integration.nws", "integration.mail", "integration.crm", "integration.payments", "integration.model"] as const;

/**
 * Handlers for events the producers actually emit.
 * Weather refetch is read-only. Mail, CRM, payments, and model replays do not
 * repeat the external action: a key that already applied is a no-op success,
 * and a key that never applied is not sent again from here.
 */
export function registerIntegrationHandlers(): void {
  registerBusHandler({
    type: "weather.refresh",
    maxTier: 0,
    decide: () => ({ act: true, reason: "refresh public alerts" }),
    act: async (event) => refetchWeather(event.tenantId, event.idempotencyKey),
  });
  registerBusHandler({
    type: "integration.nws",
    maxTier: 0,
    decide: () => ({ act: true, reason: "refetch public alerts" }),
    act: async (event) => refetchWeather(event.tenantId, event.idempotencyKey),
  });
  for (const type of ["integration.mail", "integration.crm", "integration.payments", "integration.model"] as const) {
    registerBusHandler({
      type,
      maxTier: 0,
      decide: () => ({ act: true, reason: "do not repeat the external action" }),
      act: async (event) => {
        if (effectWasApplied(event.tenantId, event.idempotencyKey)) return { ok: true, duplicate: true };
        const retried = await runMockRetry(event.tenantId, event.idempotencyKey);
        if (retried) return retried;
        return { ok: true, skipped: true };
      },
    });
  }
}

async function refetchWeather(tenantId: string, key: string): Promise<Record<string, unknown>> {
  if (effectWasApplied(tenantId, key)) return { ok: true, duplicate: true, count: 0 };
  const r = await fetchNwsAlerts({ tenantId, direct: true });
  return { ok: true, count: r.alerts.length, degraded: r.degraded === true };
}
