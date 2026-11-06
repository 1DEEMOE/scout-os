import type { ScoreFactor, SignalForScoring, Vertical } from "./types";

function relevance(s: SignalForScoring): ScoreFactor {
  if (s.kind === "tornado") return { points: 30, max: 30, why: "Tornado report" };
  if (s.kind === "hail") {
    const m = s.magnitude;
    if (m === null) return { points: 8, max: 30, why: "Hail report, size not given" };
    if (m >= 1.75) return { points: 30, max: 30, why: `Hail ${m.toFixed(2)} in. (1.75 in. or larger)` };
    if (m >= 1) return { points: 20, max: 30, why: `Hail ${m.toFixed(2)} in. (1 in. or larger)` };
    return { points: 8, max: 30, why: `Hail ${m.toFixed(2)} in. (under 1 in.)` };
  }
  const m = s.magnitude;
  if (m === null) return { points: 6, max: 30, why: "Wind report, speed not measured (UNK)" };
  if (m >= 75) return { points: 20, max: 30, why: `Wind ${m} mph (75 mph or more)` };
  if (m >= 58) return { points: 12, max: 30, why: `Wind ${m} mph (58 mph or more)` };
  return { points: 6, max: 30, why: `Wind ${m} mph (under 58 mph)` };
}

function describe(s: SignalForScoring): string {
  if (s.kind === "tornado") return "a tornado report";
  if (s.kind === "hail") return s.magnitude === null ? "a hail report" : `a hail report of ${s.magnitude.toFixed(2)} in.`;
  return s.magnitude === null ? "a wind report (speed not measured)" : `a wind report of ${s.magnitude} mph`;
}

export const roofing: Vertical = {
  id: "roofing",
  label: "Residential roofing",
  status: "active",
  signalKinds: ["hail", "wind", "tornado"],
  suggestedServices: ["Roof inspection", "Roof repair", "Roof replacement", "Insurance claim support", "Gutter repair"],
  qualification: [
    { id: "owns_property", question: "Did they say they own the property?" },
    { id: "wants_inspection", question: "Did they ask for an inspection or a quote?" },
    { id: "in_service_area", question: "Is the property inside the area you serve?" },
    { id: "timeline", question: "Did they give a timeline?" },
  ],
  signalRelevance: relevance,
  describeSignal: describe,
  whyRelevant:
    "Storm reports near a property are the trigger this roofing profile uses to suggest offering an inspection. A storm report is not evidence of damage to this property.",
  limitations:
    "NOAA SPC local storm reports are preliminary and not quality-controlled. Locations are approximate. Nothing here shows damage to any specific property.",
};
