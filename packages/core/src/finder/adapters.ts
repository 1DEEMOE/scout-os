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
