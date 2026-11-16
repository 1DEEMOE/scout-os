import { adminQuery, adminUrl, withTenant } from "@wos/db";
import { planSpec } from "../billing/plans";
import { integrations } from "../events/breaker";
import { produceIntegration } from "../events/produce";
import { logger } from "../logger";
import { fetchAllowlisted } from "../security/ssrf";
import { ingestSpcSignals } from "./signal-ingest";
import { parseSpcCsv } from "./spc";

/**
 * Automatic NOAA SPC storm-report feed. Replaces the manual "download a file
 * from SPC and upload it" step: the worker calls syncStormReportsAllTenants
 * on an interval, which fetches the current and previous report days for
 * every eligible org and ingests whatever is new.
 *
 * Facts about the source (verified against the live site, 2026-11):
 * - Files live at https://www.spc.noaa.gov/climo/reports/YYMMDD_rpts_filtered.csv
 * - A report day runs 12:00 UTC to 11:59 UTC the next day and is named by the
 *   date it starts, so before 12:00 UTC "today's" file is yesterday's date.
 * - A not-yet-created day file answers 404; a quiet day answers 200 with
 *   section headers and no rows. Both mean "no reports", never an error.
 *
 * Reliability: the fetch goes through the SSRF allowlist, the spc circuit
 * breaker, and the event bus, so a failure is dead-lettered and replayable
 * from the Recovery page (integration.spc refetches). Ingestion is idempotent
 * via the (tenant_id, external_ref) unique index, so the 6-hourly overlap of
 * report days is free. In WOS_MOCK_MODE no network call is made.
 */

export const SPC_HOST = "www.spc.noaa.gov";
const SPC_USER_AGENT = process.env.WOS_SPC_USER_AGENT || "AscendSoftware/0.1 (storm-report sync; contact: ops@example.invalid)";
/** Fetching more than the upload cap is a bug or a hostile payload, not a report day. */
const MAX_SPC_BYTES = 2_000_000;
/** Re-sync this many previous report days; late reports trickle in and dedupe makes it free. */
const LOOKBACK_DAYS = 2;

export type SpcSyncStatus = "ingested" | "no_reports" | "skipped_mock";

export interface SpcDayResult {
  tenantId: string;
  day: string;
  status: SpcSyncStatus;
  added: number;
  duplicates: number;
  rejected: number;
}

/** The SPC report day containing `now` (12:00 UTC boundary, named by start date). */
export function currentSpcReportDay(now: Date): string {
  const d = new Date(now.getTime());
  if (d.getUTCHours() < 12) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Current report day first, then LOOKBACK_DAYS previous ones. */
export function spcSyncDays(now: Date): string[] {
  const first = currentSpcReportDay(now);
  const out = [first];
  let t = new Date(`${first}T00:00:00Z`).getTime();
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    t -= 86_400_000;
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export function spcCsvUrl(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(new Date(`${day}T00:00:00Z`).getTime())) {
    throw new Error("report day must be YYYY-MM-DD");
  }
  const ymd = day.slice(2).replaceAll("-", "");
  return `https://${SPC_HOST}/climo/reports/${ymd}_rpts_filtered.csv`;
}

let fetchOverride: typeof fetch | undefined;

/** Test hook; replay uses the same fetch as the producer. */
export function setSpcFetchForTests(fn?: typeof fetch): void {
  fetchOverride = fn;
}

export function resetSpcSyncForTests(): void {
  fetchOverride = undefined;
  integrations.reset("spc");
}

const mockMode = () => process.env.WOS_MOCK_MODE === "1";

/**
 * Syncs one report day for one org through the event bus. Failures are
 * dead-lettered (integration.spc) and replay refetches the same day.
 */
export async function syncSpcDay(tenantId: string, day: string): Promise<SpcDayResult> {
  if (mockMode() && !fetchOverride) {
    logger.debug({ tenantId, day }, "spc sync skipped: mock mode");
    return { tenantId, day, status: "skipped_mock", added: 0, duplicates: 0, rejected: 0 };
  }
  return produceIntegration({
    tenantId,
    integration: "spc",
    idempotencyKey: spcSyncKey(day),
    effect: (ctx) => fetchAndIngestDay(tenantId, day, ctx.signal),
  });
}

export function spcSyncKey(day: string): string {
  return `spc.sync:${day}`;
}

export function spcDayFromKey(key: string): string | null {
  const m = /^spc\.sync:(\d{4}-\d{2}-\d{2})$/.exec(key);
  return m?.[1] ?? null;
}

/**
 * Replay path for Recovery: refetch + ingest directly, without opening a
 * nested bus event (mirrors the NWS replay, which also fetches direct).
 */
export async function resyncSpcDayDirect(tenantId: string, day: string): Promise<SpcDayResult> {
  return fetchAndIngestDay(tenantId, day);
}

async function fetchAndIngestDay(tenantId: string, day: string, signal?: AbortSignal): Promise<SpcDayResult> {
  const doFetch = fetchOverride ?? fetch;
  const text = await integrations.run("spc", async () => {
    const res = await fetchAllowlisted(spcCsvUrl(day), { signal, headers: { Accept: "text/csv", "User-Agent": SPC_USER_AGENT } }, doFetch);
    if (res.status === 404) return null; // day file not created yet — a normal quiet period, not a failure
    if (!res.ok) throw new Error(`spc.noaa.gov responded ${res.status}`);
    const body = await res.text();
    if (Buffer.byteLength(body) > MAX_SPC_BYTES) throw new Error("spc.noaa.gov file exceeds the 2 MB report-day cap");
    return body;
  });
  if (text === null) return { tenantId, day, status: "no_reports", added: 0, duplicates: 0, rejected: 0 };
  const parsed = parseSpcCsv(text, day);
  if (!parsed.signals.length) return { tenantId, day, status: "no_reports", added: 0, duplicates: 0, rejected: parsed.rejected.length };
  const result = await withTenant(tenantId, (tx) =>
    ingestSpcSignals(tx, {
      tenantId,
      day,
      parsed,
      sourceLabel: `SPC storm reports ${day} (auto)`,
      actor: { type: "system", id: "storm-sync" },
      action: "scout.signals.sync",
      skipEmptySource: true,
    }),
  );
  logger.info({ tenantId, day, added: result.added, duplicates: result.duplicates, rejected: result.rejected.length }, "spc storm reports synced");
  return { tenantId, day, status: "ingested", added: result.added, duplicates: result.duplicates, rejected: result.rejected.length };
}

export interface StormFanoutResult {
  disabled?: boolean;
  tenants: number;
  ingested: number;
  noReports: number;
  skippedMock: number;
  failed: number;
}

interface EligibleTenant {
  tenant_id: string;
  plan: string;
}

/** Orgs that should receive storm data: reviewed business profile + the scout feature on their plan. */
export async function listStormSyncTenants(): Promise<EligibleTenant[]> {
  const rows = await adminQuery<EligibleTenant>(
    `SELECT bp.tenant_id, o.plan
       FROM business_profiles bp
       JOIN organizations o ON o.id = bp.tenant_id
      WHERE bp.status = 'reviewed'
      ORDER BY bp.tenant_id
      LIMIT 1000`,
  );
  return rows.filter((r) => planSpec(r.plan).features.includes("scout"));
}

/**
 * One fan-out pass: every eligible org × every day in the sync window. A
 * per-day failure dead-letters that day only; the other days and orgs still
 * run. Requires DATABASE_URL_ADMIN for the cross-tenant listing (same rule
 * as the routine reconciler); without it the pass reports disabled.
 */
export async function syncStormReportsAllTenants(opts: { now?: Date } = {}): Promise<StormFanoutResult> {
  if (!adminUrl()) {
    logger.warn("storm sync disabled: DATABASE_URL_ADMIN is not set");
    return { disabled: true, tenants: 0, ingested: 0, noReports: 0, skippedMock: 0, failed: 0 };
  }
  const tenants = await listStormSyncTenants();
  const days = spcSyncDays(opts.now ?? new Date());
  const out: StormFanoutResult = { tenants: tenants.length, ingested: 0, noReports: 0, skippedMock: 0, failed: 0 };
  for (const t of tenants) {
    for (const day of days) {
      try {
        const r = await syncSpcDay(t.tenant_id, day);
        if (r.status === "ingested") out.ingested += 1;
        else if (r.status === "no_reports") out.noReports += 1;
        else out.skippedMock += 1;
      } catch (err) {
        out.failed += 1;
        logger.error({ err, tenantId: t.tenant_id, day }, "spc sync day failed (dead-lettered)");
      }
    }
  }
  return out;
}
