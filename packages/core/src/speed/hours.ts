/** TCPA-style quiet hours: texts only from 8:00 inclusive to 21:00 exclusive, recipient local time. */

export function localMinutes(now: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return null; // unknown zone: fail closed
  }
}

/** True when an SMS may be sent. Email is not limited by this window. */
export function smsWindowOpen(now: Date, timeZone: string): boolean {
  const mins = localMinutes(now, timeZone);
  if (mins === null) return false;
  return mins >= 8 * 60 && mins < 21 * 60;
}
