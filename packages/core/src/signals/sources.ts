import type { IndustryPack, SignalSourceId } from "../industries/packs";
import { alertKind, type NwsAlert } from "../speed/nws";

/**
 * Signal sources are data providers. Weather is one of them, used only by
 * packs that list it. The others are calendars or mock adapters. Scores are
 * points with a reason, not a probability, and none of them claim damage.
 */
export interface SignalHit {
  source: SignalSourceId;
  title: string;
  detail: string;
  points: number;
  max: number;
  why: string;
  limit: string;
  demo: boolean;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function seasonalHits(pack: IndustryPack, now: Date): SignalHit[] {
  if (!pack.signals.includes("seasonal") || !pack.seasons?.length) return [];
  const month = now.getUTCMonth() + 1;
  return pack.seasons
    .filter((s) => s.month === month)
    .map((s) => ({
      source: "seasonal" as const,
      title: s.label,
      detail: `${MONTHS[s.month - 1]} note from the ${pack.label} pack`,
      points: 12,
      max: 20,
      why: "The pack's calendar says this month is a busy one. It is not a forecast for a particular customer.",
      limit: "A calendar note. It does not say any one customer needs work.",
      demo: false,
    }));
}

export function reserviceHits(pack: IndustryPack, daysSince: { serviceId: string; days: number }[]): SignalHit[] {
  if (!pack.signals.includes("reservice") || !pack.rebookEveryDays?.length) return [];
  const hits: SignalHit[] = [];
  for (const rule of pack.rebookEveryDays) {
    const seen = daysSince.find((d) => d.serviceId === rule.serviceId);
    if (!seen || seen.days < rule.days) continue;
    hits.push({
      source: "reservice",
      title: rule.label,
      detail: `${seen.days} days since the last ${rule.serviceId.replaceAll("_", " ")}`,
      points: 14,
      max: 20,
      why: "Their own last visit is older than the pack's usual interval.",
      limit: "An interval, not a promise they want to book.",
      demo: false,
    });
  }
  return hits;
}

/** Mock until a real permit or mover feed exists. Always labelled. */
export function mockFeedHits(pack: IndustryPack): SignalHit[] {
  const hits: SignalHit[] = [];
  if (pack.signals.includes("new_mover")) {
    hits.push({
      source: "new_mover",
      title: "MOCK new-mover notice",
      detail: "Sample only. No mover list is connected.",
      points: 8,
      max: 20,
      why: "The pack can use mover data later. This row is a placeholder.",
      limit: "Not a real person and not a real move.",
      demo: true,
    });
  }
  if (pack.signals.includes("permit")) {
    hits.push({
      source: "permit",
      title: "MOCK permit notice",
      detail: "Sample only. No permit office is connected.",
      points: 8,
      max: 20,
      why: "The pack can use permit data later. This row is a placeholder.",
      limit: "Not a real permit and not a bid.",
      demo: true,
    });
  }
  return hits;
}

export function weatherHits(pack: IndustryPack, alerts: NwsAlert[]): SignalHit[] {
  if (!pack.signals.includes("weather")) return [];
  return alerts.flatMap((a) => {
    const kind = alertKind(a.event, a.headline);
    if (!kind) return [];
    return [{
      source: "weather" as const,
      title: a.event,
      detail: a.area || a.headline,
      points: kind === "tornado" ? 18 : 14,
      max: 20,
      why: "A National Weather Service alert covers an area. It is not a statement that a particular building was hit.",
      limit: "Area warning, not a damage inspection.",
      demo: a.id.startsWith("mock:"),
    }];
  });
}

export function collectSignals(pack: IndustryPack, ctx: { now: Date; alerts?: NwsAlert[]; daysSince?: { serviceId: string; days: number }[] }): SignalHit[] {
  return [
    ...seasonalHits(pack, ctx.now),
    ...reserviceHits(pack, ctx.daysSince ?? []),
    ...weatherHits(pack, ctx.alerts ?? []),
    ...mockFeedHits(pack),
  ];
}
