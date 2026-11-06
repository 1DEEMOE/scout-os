import type { ScoreFactor, SignalForScoring, Vertical } from "./verticals";

/**
 * Heuristic score (ADR-004 §6). Plain rules, not a probability: there are no
 * historical outcomes to calibrate against. Each factor carries its reason,
 * and the total is always the sum of the factors.
 */
export interface ScoreInput {
  signal: SignalForScoring & { eventAt: Date };
  /** Miles between prospect and report, or null when matched by county only. */
  distanceMiles: number | null;
  reliability: "crm_contact" | "import_with_coordinates" | "import_county_only";
  engaged: boolean;
  now: Date;
}

export interface ScoreBreakdown {
  signalRelevance: ScoreFactor;
  freshness: ScoreFactor;
  geographicFit: ScoreFactor;
  dataReliability: ScoreFactor;
  verifiedEngagement: ScoreFactor;
}

export function freshness(eventAt: Date, now: Date): ScoreFactor {
  const days = Math.max(0, (now.getTime() - eventAt.getTime()) / 86_400_000);
  const d = Math.floor(days);
  const ago = d === 0 ? "today" : `${d} day${d === 1 ? "" : "s"} ago`;
  if (days <= 7) return { points: 20, max: 20, why: `Reported ${ago} (within 7 days)` };
  if (days <= 30) return { points: 14, max: 20, why: `Reported ${ago} (within 30 days)` };
  if (days <= 90) return { points: 8, max: 20, why: `Reported ${ago} (within 90 days)` };
  return { points: 2, max: 20, why: `Reported ${ago} (over 90 days)` };
}

export function geographicFit(distanceMiles: number | null): ScoreFactor {
  if (distanceMiles === null) return { points: 8, max: 20, why: "Same county; no exact location to measure distance" };
  const d = distanceMiles.toFixed(1);
  if (distanceMiles <= 3) return { points: 20, max: 20, why: `${d} miles away (within 3)` };
  if (distanceMiles <= 10) return { points: 14, max: 20, why: `${d} miles away (within 10)` };
  return { points: 6, max: 20, why: `${d} miles away` };
}

function reliability(r: ScoreInput["reliability"]): ScoreFactor {
  if (r === "crm_contact") return { points: 15, max: 15, why: "Matches a contact already in your CRM" };
  if (r === "import_with_coordinates") return { points: 10, max: 15, why: "From your attested import, with coordinates" };
  return { points: 5, max: 15, why: "From your attested import, county only" };
}

export function scoreMatch(v: Vertical, input: ScoreInput): { score: number; breakdown: ScoreBreakdown } {
  const breakdown: ScoreBreakdown = {
    signalRelevance: v.signalRelevance(input.signal),
    freshness: freshness(input.signal.eventAt, input.now),
    geographicFit: geographicFit(input.distanceMiles),
    dataReliability: reliability(input.reliability),
    verifiedEngagement: input.engaged
      ? { points: 15, max: 15, why: "They've been in touch, or are an existing customer (recorded)" }
      : { points: 0, max: 15, why: "No recorded contact from them yet" },
  };
  const score = Object.values(breakdown).reduce((n, f) => n + f.points, 0);
  return { score, breakdown };
}
