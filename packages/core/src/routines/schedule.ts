/**
 * Wall-clock schedules in IANA time zones, DST-correct, no dependencies.
 *
 * Rules (documented in the R1 report):
 * - Spring-forward gap (e.g. 02:30 on the day clocks jump 02:00→03:00): the run
 *   happens at the first valid instant after the gap at the same offset (03:30).
 * - Fall-back overlap (01:30 happens twice): the run happens once, at the first
 *   occurrence (the daylight-time one).
 */
export interface Schedule {
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  daysOfWeek: number[];
  timezone: string;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function wallTime(at: Date, tz: string): WallTime {
  const p = Object.fromEntries(fmt(tz).formatToParts(at).map((x) => [x.type, x.value]));
  return { year: +p.year!, month: +p.month!, day: +p.day!, hour: +p.hour! % 24, minute: +p.minute!, second: +p.second! };
}

/** UTC offset of `tz` at instant `ms`, in ms (wall − UTC). */
function offsetAt(ms: number, tz: string): number {
  const w = wallTime(new Date(ms), tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time happens in `tz`, applying the gap/overlap rules above. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const day_ = 86_400_000;
  const offsets = [...new Set([offsetAt(naive - day_, tz), offsetAt(naive, tz), offsetAt(naive + day_, tz)])];
  const candidates = offsets.map((o) => naive - o);
  const exact = candidates.filter((c) => {
    const w = wallTime(new Date(c), tz);
    return w.year === year && w.month === month && w.day === day && w.hour === hour && w.minute === minute;
  });
  // Overlap: earliest real occurrence. Gap: none match; the latest candidate lands just after the gap.
  return new Date(exact.length ? Math.min(...exact) : Math.max(...candidates));
}

export function validateSchedule(s: Schedule): string | null {
  if (!Number.isInteger(s.hour) || s.hour < 0 || s.hour > 23) return "Hour must be 0–23";
  if (!Number.isInteger(s.minute) || s.minute < 0 || s.minute > 59) return "Minute must be 0–59";
  if (!Array.isArray(s.daysOfWeek) || s.daysOfWeek.length < 1 || s.daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return "Pick at least one day";
  if (!isValidTimeZone(s.timezone)) return `Unknown time zone "${s.timezone}"`;
  return null;
}

/** The first scheduled instant strictly after `after`. */
export function nextRunAfter(s: Schedule, after: Date): Date {
  const err = validateSchedule(s);
  if (err) throw new Error(err);
  const days = new Set(s.daysOfWeek);
  const start = wallTime(after, s.timezone);
  for (let i = 0; i <= 8; i++) {
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    if (!days.has(d.getUTCDay())) continue;
    const at = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), s.hour, s.minute, s.timezone);
    if (at.getTime() > after.getTime()) return at;
  }
  throw new Error("no next run found within 8 days"); // unreachable with ≥1 day selected
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function describeSchedule(s: Schedule): string {
  const t = `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
  const sorted = [...s.daysOfWeek].sort();
  const days = sorted.length === 7 ? "every day" : sorted.join() === "1,2,3,4,5" ? "weekdays" : sorted.map((d) => DAY_NAMES[d]).join(", ");
  return `${days} at ${t} (${s.timezone})`;
}
