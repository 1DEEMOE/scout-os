import { createHash, randomUUID } from "node:crypto";
import { integrations } from "../events/breaker";
import { produceIntegration } from "../events/produce";
import { fetchAllowlisted } from "../security/ssrf";

/**
 * National Weather Service public alerts (api.weather.gov). No API key.
 * Cached in process for ten minutes. A failed fetch does not invent alerts;
 * the caller may use the labelled mock fallback when WOS_MOCK_MODE is on.
 */

export const NWS_USER_AGENT = process.env.WOS_NWS_USER_AGENT || "ScoutOS/0.1 (speed-to-lead; https://example.invalid)";
const CACHE_MS = 10 * 60 * 1000;

export interface NwsAlert {
  id: string;
  event: string;
  area: string;
  effective: string;
  headline: string;
}

export const NWS_CONFIDENCE = "National Weather Service alert from api.weather.gov. It says a warning was issued for an area. It is not a damage inspection and not evidence that any roof was hit.";
export const NWS_LIMITATIONS = "The area is a county or zone, not a street address. A warning is a forecast, not a report that weather reached a particular building.";

interface CacheEntry {
  at: number;
  alerts: NwsAlert[];
}
const cache = new Map<string, CacheEntry>();

export function resetNwsCache(): void {
  cache.clear();
  integrations.reset("nws");
}

export function alertKind(event: string, headline: string): "tornado" | "hail" | "wind" | null {
  const t = `${event} ${headline}`.toLowerCase();
  if (t.includes("tornado")) return "tornado";
  if (t.includes("hail")) return "hail";
  if (t.includes("thunderstorm") || t.includes("wind")) return "wind";
  return null;
}

/** "Dallas County, TX; Tarrant County, TX" → pairs. Unparsed fragments are dropped. */
export function countiesOf(areaDesc: string): { county: string; state: string }[] {
  const out: { county: string; state: string }[] = [];
  for (const part of areaDesc.split(";")) {
    const m = /^\s*([A-Za-z .'-]+?)\s+County,\s*([A-Z]{2})\s*$/i.exec(part);
    if (!m) continue;
    out.push({ county: m[1]!.replace(/\s+/g, " ").trim(), state: m[2]!.toUpperCase() });
  }
  return out;
}

export function parseNwsPayload(body: unknown): NwsAlert[] {
  const features = (body as { features?: unknown })?.features;
  if (!Array.isArray(features)) return [];
  const alerts: NwsAlert[] = [];
  for (const f of features) {
    const p = (f as { properties?: Record<string, unknown> })?.properties;
    if (!p || typeof p.event !== "string") continue;
    const id = typeof (f as { id?: unknown }).id === "string" ? (f as { id: string }).id : `${p.event}|${p.areaDesc ?? ""}|${p.effective ?? ""}`;
    alerts.push({
      id: id.slice(0, 300),
      event: p.event.slice(0, 120),
      area: typeof p.areaDesc === "string" ? p.areaDesc.slice(0, 500) : "",
      effective: typeof p.effective === "string" ? p.effective : new Date().toISOString(),
      headline: typeof p.headline === "string" ? p.headline.slice(0, 300) : p.event,
    });
  }
  return alerts;
}

export function alertsUrl(area?: string): string {
  const base = "https://api.weather.gov/alerts/active?status=actual&message_type=alert";
  return area ? `${base}&area=${encodeURIComponent(area)}` : base;
}

async function fetchNwsOnce(opts: { fetchImpl?: typeof fetch; now?: Date; area?: string; signal?: AbortSignal }): Promise<{ alerts: NwsAlert[]; cached: boolean; degraded?: boolean }> {
  const url = alertsUrl(opts.area);
  const now = opts.now ?? new Date();
  const hit = cache.get(url);
  if (hit && now.getTime() - hit.at < CACHE_MS) return { alerts: hit.alerts, cached: true };
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await integrations.run("nws", async () => {
      const response = await fetchAllowlisted(url, { signal: opts.signal, headers: { Accept: "application/geo+json", "User-Agent": NWS_USER_AGENT } }, doFetch);
      if (response.status >= 500 || response.status === 408) throw new Error(`weather.gov responded ${response.status}`);
      if (!response.ok) throw new Error(`weather.gov responded ${response.status}`);
      return response;
    }, now.getTime());
    const alerts = parseNwsPayload(await res.json());
    cache.set(url, { at: now.getTime(), alerts });
    return { alerts, cached: false };
  } catch (err) {
    if (hit) return { alerts: hit.alerts, cached: true, degraded: true };
    throw err;
  }
}

/** Public entry. Goes through the event bus so a failure is dead-lettered when a tenant is known. */
export async function fetchNwsAlerts(opts: { fetchImpl?: typeof fetch; now?: Date; area?: string; signal?: AbortSignal; tenantId?: string; direct?: boolean } = {}): Promise<{ alerts: NwsAlert[]; cached: boolean; degraded?: boolean }> {
  if (opts.direct || !opts.tenantId) return fetchNwsOnce(opts);
  return produceIntegration({
    tenantId: opts.tenantId,
    integration: "nws",
    idempotencyKey: `nws:${randomUUID()}`,
    effect: (ctx) => fetchNwsOnce({ ...opts, signal: ctx.signal }),
  });
}

/** Stable id so the same alert stored twice is one signal. */
export function alertRef(alertId: string, state: string, county: string): string {
  return "nws:" + createHash("sha256").update(`${alertId}|${state}|${county}`).digest("hex").slice(0, 32);
}

/** One labelled sample used only when the live fetch fails in mock mode. */
export function mockStormAlerts(): NwsAlert[] {
  return [{
    id: "mock:severe-thunderstorm",
    event: "Severe Thunderstorm Warning",
    area: "Dallas County, TX",
    effective: "2026-11-06T18:00:00Z",
    headline: "MOCK National Weather Service sample. Not a live alert.",
  }];
}
