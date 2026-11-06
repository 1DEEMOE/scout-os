import { createHash } from "node:crypto";
import type { SignalKind } from "@wos/db";
import { parseCsv, stripControl } from "./csv";

/**
 * NOAA Storm Prediction Center local storm reports.
 *
 * Format facts verified on SPC's report pages (see ADR-004 §6):
 * - Times are UTC (HHMM). A report day runs 12:00 UTC to 11:59 UTC the next
 *   day, so a time before 1200 belongs to the next calendar date.
 * - Hail size is in hundredths of an inch (175 = 1.75 in.).
 * - Wind speed is mph, or "UNK" when not measured.
 * - Columns: Time, F_Scale|Speed|Size, Location, County, State, Lat, Lon, Comments.
 * - The CSV gives decimal coordinates; the HTML page gives digit strings
 *   (3719 = 37.19 N, 9935 = 99.35 W). Both are accepted.
 * The CSV holds no date, so the report day comes from the file name
 * (YYMMDD_rpts...) or from the person uploading it.
 */
export const SPC_CONFIDENCE = "Preliminary NOAA SPC local storm report; not quality-controlled.";
export const SPC_LIMITATIONS = "Location is approximate (a named place with an offset). A report says weather happened there, not that any property was damaged.";
export const SPC_USAGE_RIGHTS = "NOAA Storm Prediction Center data: work of the US federal government, public domain in the US.";

export interface ParsedSignal {
  kind: SignalKind;
  eventAt: Date;
  location: string;
  county: string;
  state: string;
  lat: number | null;
  lon: number | null;
  magnitude: number | null;
  magnitudeUnit: "in" | "mph" | null;
  comments: string;
  externalRef: string;
}

export interface SpcParseResult {
  signals: ParsedSignal[];
  rejected: { line: number; reason: string }[];
}

/** "241104_rpts_filtered.csv" → "2024-11-04". */
export function reportDayFromFilename(name: string): string | null {
  const m = /(?:^|[^0-9])(\d{2})(\d{2})(\d{2})_rpts/.exec(name);
  if (!m) return null;
  const [, yy, mm, dd] = m;
  const d = `20${yy}-${mm}-${dd}`;
  return isValidDay(d) ? d : null;
}

function isValidDay(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

function kindFromHeader(h: string): SignalKind | null {
  const k = h.trim().toLowerCase();
  if (k === "f_scale" || k === "ef_scale") return "tornado";
  if (k === "speed") return "wind";
  if (k === "size") return "hail";
  return null;
}

function coord(raw: string, axis: "lat" | "lon"): number | null {
  const v = raw.trim();
  if (!v) return null;
  let n: number;
  if (/^-?\d+\.\d+$/.test(v) || (/^-\d+$/.test(v))) n = Number(v);
  else if (/^\d{4,5}$/.test(v)) {
    // SPC HTML digit strings: hundredths of a degree, longitude west. Only
    // accepted where the result is plausible for US reports, so "999" or
    // "12" is never read as a coordinate.
    n = (Number(v) / 100) * (axis === "lon" ? -1 : 1);
    if (axis === "lat" ? n < 17 || n > 72 : n > -60 || n < -180) return null;
  } else return null;
  if (!Number.isFinite(n)) return null;
  if (axis === "lat" && (n < -90 || n > 90)) return null;
  if (axis === "lon" && (n < -180 || n > 180)) return null;
  return Math.round(n * 10000) / 10000;
}

/** UTC event time for an SPC report day and HHMM. */
export function eventTime(reportDay: string, hhmm: string): Date | null {
  if (!/^\d{3,4}$/.test(hhmm.trim())) return null;
  const v = hhmm.trim().padStart(4, "0");
  const h = Number(v.slice(0, 2));
  const m = Number(v.slice(2));
  if (h > 23 || m > 59) return null;
  const base = new Date(`${reportDay}T00:00:00Z`);
  if (h < 12) base.setUTCDate(base.getUTCDate() + 1);
  base.setUTCHours(h, m, 0, 0);
  return base;
}

function magnitude(kind: SignalKind, raw: string): { value: number | null; unit: "in" | "mph" | null } | "bad" {
  const v = raw.trim().toUpperCase();
  if (kind === "tornado") return { value: null, unit: null }; // F/EF scale is not a size or speed
  if (v === "UNK" || v === "") return { value: null, unit: kind === "hail" ? "in" : "mph" };
  if (!/^\d+$/.test(v)) return "bad";
  const n = Number(v);
  if (kind === "hail") return n > 0 && n <= 1000 ? { value: n / 100, unit: "in" } : "bad";
  return n > 0 && n <= 300 ? { value: n, unit: "mph" } : "bad";
}

const clean = (s: string, max: number) => stripControl(s).trim().slice(0, max);

/**
 * Parses an SPC CSV: the combined daily file (three headed sections) or a
 * single section. Bad rows are reported, never guessed.
 */
export function parseSpcCsv(text: string, reportDay: string): SpcParseResult {
  if (!isValidDay(reportDay)) throw new Error("report day must be YYYY-MM-DD");
  const rows = parseCsv(text);
  const signals: ParsedSignal[] = [];
  const rejected: { line: number; reason: string }[] = [];
  let kind: SignalKind | null = null;
  rows.forEach((r, idx) => {
    const line = idx + 1;
    if (r[0]?.trim().toLowerCase() === "time") {
      kind = kindFromHeader(r[1] ?? "");
      if (!kind) rejected.push({ line, reason: `unknown section header "${clean(r[1] ?? "", 30)}"` });
      return;
    }
    if (!kind) return void rejected.push({ line, reason: "row before any section header" });
    if (r.length < 7) return void rejected.push({ line, reason: "fewer than 7 columns" });
    const [time = "", mag = "", location = "", county = "", state = "", lat = "", lon = "", ...rest] = r;
    const at = eventTime(reportDay, time);
    if (!at) return void rejected.push({ line, reason: `bad time "${clean(time, 10)}"` });
    const st = state.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(st)) return void rejected.push({ line, reason: "bad state" });
    const m = magnitude(kind, mag);
    if (m === "bad") return void rejected.push({ line, reason: `bad ${kind === "hail" ? "size" : "speed"} "${clean(mag, 10)}"` });
    const la = coord(lat, "lat");
    const lo = coord(lon, "lon");
    const s: ParsedSignal = {
      kind,
      eventAt: at,
      location: clean(location, 200) || "Unknown",
      county: clean(county, 100) || "Unknown",
      state: st,
      lat: la !== null && lo !== null ? la : null,
      lon: la !== null && lo !== null ? lo : null,
      magnitude: m.value,
      magnitudeUnit: m.unit,
      comments: clean(rest.join(","), 2000), // comments may contain commas
      externalRef: "",
    };
    s.externalRef = "spc:" + createHash("sha256").update([s.kind, s.eventAt.toISOString(), s.state, s.county, s.location, s.lat, s.lon, s.magnitude].join("|")).digest("hex").slice(0, 32);
    signals.push(s);
  });
  return { signals, rejected };
}
