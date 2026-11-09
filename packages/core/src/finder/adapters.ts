/**
 * Public-signal adapters for the opportunity finder. One interface, many
 * feeds: storm reports, building permits, and more later (code violations,
 * insurance-claim heat maps, property sales).
 *
 * Every adapter here is MOCK: deterministic, invented records, no network.
 * A live adapter (NOAA SPC daily reports, a county's open-data permit API)
 * plugs in behind the same interface once its licence and terms are reviewed
 * (docs/research/license-register.md).
 */
import { createHash } from "node:crypto";

export interface Area {
  county: string;
  state: string;
}

export interface StormReport {
  kind: "hail" | "wind" | "tornado";
  /** Hail size in hundredths of an inch, or wind speed in mph. */
  magnitude: number | null;
  location: string;
  county: string;
  state: string;
  lat: number;
  lon: number;
  timeUtc: string; // HHMM, SPC style
  comments: string;
}

export interface PermitRecord {
  permitNumber: string;
  type: "re-roof" | "roof repair" | "gutters" | "siding";
  issuedOn: string; // YYYY-MM-DD
  ownerName: string;
  ownerEmail: string | null;
  address: string;
  city: string;
  county: string;
  state: string;
  zip: string;
  lat: number;
  lon: number;
}

export interface SignalAdapter<T> {
  readonly id: string;
  readonly label: string;
  readonly kind: "storm" | "permit";
  /** True for invented data. The UI labels these MOCK. */
  readonly mock: boolean;
  /** What a live version would read, and its terms, for the reviewer. */
  readonly source: string;
  fetch(area: Area, opts: { day: string; now: Date }): Promise<T[]>;
}

/** Stable pseudo-random numbers from a seed, so the same area gives the same records. */
function rng(seed: string) {
  let h = createHash("sha256").update(seed).digest();
  let i = 0;
  return () => {
    if (i + 4 > h.length) {
      h = createHash("sha256").update(h).digest();
      i = 0;
    }
    const v = h.readUInt32BE(i) / 0xffffffff;
    i += 4;
    return v;
  };
}

/** A stable invented centre for an area. Storms and permits share it, so distances line up. */
export function areaCentre(a: Area): { lat: number; lon: number } {
  const r = rng(`centre|${a.county.toLowerCase()}|${a.state.toUpperCase()}`);
  return { lat: 30 + r() * 12, lon: -98 + r() * 18 };
}

const near = (c: { lat: number; lon: number }, r: () => number, spread = 0.06) => ({
  lat: Number((c.lat + (r() - 0.5) * spread).toFixed(4)),
  lon: Number((c.lon + (r() - 0.5) * spread).toFixed(4)),
});

export const mockStormAdapter: SignalAdapter<StormReport> = {
  id: "mock-storm-reports",
  label: "Storm reports (MOCK)",
  kind: "storm",
  mock: true,
  source: "Live version: NOAA Storm Prediction Center daily local storm reports (US government work, public domain).",
  async fetch(area, { day }) {
    const r = rng(`storm|${area.county}|${area.state}|${day}`);
    const c = areaCentre(area);
    const town = `${area.county} Heights`;
    const hail = [175, 125, 100].map((size, i) => ({ kind: "hail" as const, magnitude: size, ...near(c, r), location: `${i + 1} W ${town}`, timeUtc: `21${String(10 + i * 12).padStart(2, "0")}`, comments: `${size >= 150 ? "Golf ball" : size >= 125 ? "Half dollar" : "Quarter"} size hail. (MOCK)` }));
    const wind = { kind: "wind" as const, magnitude: 65 + Math.round(r() * 10), ...near(c, r), location: town, timeUtc: "2230", comments: "Trees and limbs down. (MOCK)" };
    return [...hail, wind].map((s) => ({ ...s, county: area.county, state: area.state }));
  },
};

const FIRST = ["Avery", "Jordan", "Riley", "Morgan", "Casey", "Taylor", "Quinn", "Reese", "Drew", "Parker"];
const LAST = ["Holloway", "Brennan", "Okoro", "Lindqvist", "Ramos", "Whitfield", "Castellano", "Nakamura", "Ferris", "Delacroix"];
const STREETS = ["Magnolia Way", "Ridge Crest Dr", "Old Mill Rd", "Sycamore Ct", "Lakeview Ln", "Hickory Bend", "Cardinal St", "Willow Run"];

export const mockPermitAdapter: SignalAdapter<PermitRecord> = {
  id: "mock-building-permits",
  label: "Building permits (MOCK)",
  kind: "permit",
  mock: true,
  source: "Live version: the county or city open-data building-permit feed (terms vary by county; review each before use).",
  async fetch(area, { now }) {
    const r = rng(`permit|${area.county}|${area.state}`);
    const c = areaCentre(area);
    const year = now.getUTCFullYear();
    const zip = String(10000 + Math.floor(r() * 89999));
    return Array.from({ length: 8 }, (_, i) => {
      const first = FIRST[Math.floor(r() * FIRST.length)]!;
      const last = LAST[Math.floor(r() * LAST.length)]!;
      // Mostly old roofs (15–24 years); two recent jobs another contractor already has.
      const recent = i >= 6;
      const issued = recent ? new Date(now.getTime() - (10 + i) * 86_400_000) : new Date(Date.UTC(year - 15 - Math.floor(r() * 10), Math.floor(r() * 12), 1 + Math.floor(r() * 27)));
      const p = near(c, r, 0.08);
      return {
        permitNumber: `MOCK-${area.state}-${year - 2000}${String(1000 + i * 37)}`,
        type: recent ? ("roof repair" as const) : ("re-roof" as const),
        issuedOn: issued.toISOString().slice(0, 10),
        ownerName: `${first} ${last}`,
        ownerEmail: i % 2 === 0 ? `${first}.${last}@example.test`.toLowerCase() : null,
        address: `${100 + Math.floor(r() * 8800)} ${STREETS[i % STREETS.length]}`,
        city: `${area.county} Heights`,
        county: area.county,
        state: area.state,
        zip,
        ...p,
      };
    });
  },
};

export const SIGNAL_ADAPTERS = [mockStormAdapter, mockPermitAdapter] as const;

/* ------------------------------------------------------------------ live */

/** Where a live day's filtered storm reports live (one file per SPC report day). */
export function spcCsvUrl(day: string): string {
  const [y, m, d] = day.split("-");
  return `https://www.spc.noaa.gov/climo/reports/${y!.slice(2)}${m}${d}_rpts_filtered.csv`;
}

export const SPC_MAX_BYTES = 2 * 1024 * 1024;
const SPC_TIMEOUT_MS = 10_000;

type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null }; text(): Promise<string> }>;
let fetcher: Fetcher = (url, init) => fetch(url, init);
/** Tests only: replace the network call. */
export function setSpcFetchForTests(f: Fetcher | null): void {
  fetcher = f ?? ((url, init) => fetch(url, init));
}

export class StormFeedError extends Error {}

/**
 * Keeps only the rows for the workspace's states (section headers stay), so a
 * whole-US day doesn't flood one shop's data. State is the 5th column.
 */
export function filterSpcCsvToStates(csv: string, states: Set<string>): { csv: string; rows: number } {
  const out: string[] = [];
  let pendingHeader: string | null = null;
  let rows = 0;
  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^time,/i.test(line)) {
      pendingHeader = line;
      continue;
    }
    // Quoted commas only occur in Comments (the last column), so the first fields split safely.
    const state = line.split(",")[4]?.trim().toUpperCase();
    if (state && states.has(state)) {
      if (pendingHeader) {
        out.push(pendingHeader);
        pendingHeader = null;
      }
      out.push(line);
      rows++;
    }
  }
  return { csv: out.join("\n"), rows };
}

/**
 * LIVE: NOAA Storm Prediction Center filtered local storm reports for one
 * report day. US-government work, public domain. Preliminary and not
 * quality-controlled; a report says weather happened near a place, never that
 * a property was damaged. A missing file (404) means no reports that day.
 */
export async function fetchSpcDay(day: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SPC_TIMEOUT_MS);
  try {
    const res = await fetcher(spcCsvUrl(day), { signal: ctrl.signal, headers: { "user-agent": "ScoutOS/1.0 storm-feed", accept: "text/csv,text/plain" } });
    if (res.status === 404) return "";
    if (!res.ok) throw new StormFeedError(`NOAA storm reports answered ${res.status} for ${day}`);
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type && !/(text\/(csv|plain)|application\/(csv|octet-stream))/.test(type)) throw new StormFeedError(`NOAA storm reports for ${day} weren't CSV (${type})`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > SPC_MAX_BYTES) throw new StormFeedError(`NOAA storm reports for ${day} are larger than expected`);
    const text = await res.text();
    if (text.length > SPC_MAX_BYTES) throw new StormFeedError(`NOAA storm reports for ${day} are larger than expected`);
    if (text.trim() && !/^time,/im.test(text)) throw new StormFeedError(`NOAA storm reports for ${day} didn't look like an SPC file`);
    return text;
  } catch (err) {
    if (err instanceof StormFeedError) throw err;
    throw new StormFeedError(ctrl.signal.aborted ? `NOAA storm reports timed out for ${day}` : `Couldn't reach NOAA storm reports for ${day}`);
  } finally {
    clearTimeout(timer);
  }
}

export type StormFeedMode = "mock" | "noaa";
/** WOS_STORM_FEED=noaa turns on the live feed. Anything else (or unset) keeps the MOCK feed. */
export function stormFeedMode(): StormFeedMode {
  return process.env.WOS_STORM_FEED === "noaa" ? "noaa" : "mock";
}
