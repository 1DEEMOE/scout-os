import type { SignalKind } from "@wos/db";

export interface ScoreFactor {
  points: number;
  max: number;
  why: string;
}

export interface SignalForScoring {
  kind: SignalKind;
  magnitude: number | null;
  magnitudeUnit: "in" | "mph" | null;
}

/** Everything that differs between verticals. Code paths outside this file stay generic. */
export interface Vertical {
  id: "roofing";
  label: string;
  status: "active";
  signalKinds: readonly SignalKind[];
  /** Services offered as suggestions in onboarding. Inert until a person saves and reviews the profile. */
  suggestedServices: string[];
  /** Questions a person answers to qualify an engaged prospect. */
  qualification: { id: string; question: string }[];
  /** Points for one signal, max 30. */
  signalRelevance(s: SignalForScoring): ScoreFactor;
  /** Plain description of a signal, never a damage claim. */
  describeSignal(s: SignalForScoring): string;
  whyRelevant: string;
  limitations: string;
}

/** Verticals we intend to support. No code paths exist for these. */
export const PLANNED_VERTICALS = ["auto_glass", "hvac", "solar", "commercial_roofing"] as const;
