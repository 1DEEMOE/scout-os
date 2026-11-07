/**
 * Industry packs are configuration, not code forks. Five shared bases supply
 * stages, three approval-gated reply templates, three tier 0–1 routines, a
 * morning metric, and suggested integrations. A trade is an overlay in overlays.ts.
 */

import { OVERLAYS, type Overlay, type PackBaseId } from "./overlays";

export type { PackBaseId };

export type WorkFlow = "job" | "appointment";
export type SignalSourceId = "weather" | "seasonal" | "reservice" | "new_mover" | "permit";
export type OutreachPurpose = "first_response" | "rebook" | "no_show" | "late_cancel" | "review";

export interface PackService {
  id: string;
  label: string;
  /** Set for appointment packs. Job packs omit it. */
  durationMinutes?: number;
  /** Display only. Never charged automatically. Always an example until the owner edits it. */
  priceCents?: number;
  priceIsExample: true;
}

export interface PackRoutine {
  id: string;
  title: string;
  /** Routines act on their own only at tier 0–1. Sends stay behind templates or Approvals. */
  tier: 0 | 1;
  does: string;
}

export interface PackTemplate {
  purpose: OutreachPurpose;
  channel: "email" | "sms";
  name: string;
  /** Placeholders: {{name}} and {{business}} only. Saved as a draft until a person approves it. */
  body: string;
}

export type IntegrationKind = "calendar" | "crm" | "accounting";

export interface PackIntegration {
  kind: IntegrationKind;
  label: string;
  note: string;
}

export interface PackMetric {
  id: string;
  label: string;
}

export const PACK_GROUPS = [
  "Home services",
  "Shops",
  "Beauty & personal care",
  "Health & wellness",
  "Pets",
  "Food & hospitality",
  "Retail",
  "Professional services",
  "Education & childcare",
  "Events",
  "Startup",
  "Other",
] as const;

export type PackGroup = (typeof PACK_GROUPS)[number];

/** Bump when the pack shape changes. Every pack in this file shares it. */
export const PACK_VERSION = 1;

export interface IndustryPack {
  version: typeof PACK_VERSION;
  id: string;
  base: PackBaseId;
  label: string;
  group: PackGroup;
  summary: string;
  flow: WorkFlow;
  /** What organizations.industry may store today (the applied check constraint). */
  legacyColumn: "roofing" | "general";
  trialPlan: "scout_pro" | "growth";
  vocabulary: { work: string; customer: string };
  leadFields: { id: string; label: string }[];
  services: PackService[];
  templates: PackTemplate[];
  pipeline: string[];
  brief: string[];
  routines: PackRoutine[];
  integrations: PackIntegration[];
  metrics: PackMetric[];
  signals: readonly SignalSourceId[];
  seasons?: { month: number; label: string }[];
  rebookEveryDays?: { serviceId: string; days: number; label: string }[];
  watchLine: string;
}

const INTEGRATIONS: PackIntegration[] = [
  { kind: "calendar", label: "Calendar", note: "Suggested only. A booking is not written until you connect a calendar and approve the change." },
  { kind: "crm", label: "CRM", note: "Suggested only. A handoff waits for your OK. Nothing is written by itself." },
  { kind: "accounting", label: "Accounting", note: "Suggested only. No invoice is sent and nothing is paid automatically." },
];

const jobFields = [
  { id: "name", label: "Name" },
  { id: "phone", label: "Phone" },
  { id: "email", label: "Email" },
  { id: "address", label: "Service address" },
  { id: "request", label: "What they need" },
];

const visitFields = [
  { id: "name", label: "Name" },
  { id: "phone", label: "Phone" },
  { id: "email", label: "Email" },
  { id: "service", label: "Service" },
  { id: "when", label: "Requested time" },
];

interface BaseDef {
  flow: WorkFlow;
  pipeline: string[];
  brief: string[];
  metric: string;
  routines: PackRoutine[];
  vocabulary: IndustryPack["vocabulary"];
}

const BASES: Record<PackBaseId, BaseDef> = {
  urgent_trade: {
    flow: "job",
    pipeline: ["New lead", "Dispatched", "On site", "Quote sent", "Done"],
    brief: ["Calls today", "Open quotes", "Jobs scheduled", "Approvals"],
    metric: "Calls waiting",
    vocabulary: { work: "call", customer: "customer" },
    routines: [
      { id: "morning", title: "Morning briefing", tier: 0, does: "Read overnight calls and list them. Nothing is sent." },
      { id: "quotes", title: "Open quotes", tier: 0, does: "List quotes that have not gone out. Sending one still needs your approval." },
      { id: "callback", title: "Callback list", tier: 1, does: "List people to call back. The call is not placed and no text is sent until you approve it." },
    ],
  },
  recurring_service: {
    flow: "job",
    pipeline: ["New lead", "First visit", "On a schedule", "Due again", "Paused"],
    brief: ["Due again", "Visits today", "New leads", "Approvals"],
    metric: "Visits due again",
    vocabulary: { work: "visit", customer: "customer" },
    routines: [
      { id: "morning", title: "Morning briefing", tier: 0, does: "Read what is due today and list it. Nothing is sent." },
      { id: "due", title: "Due-again list", tier: 1, does: "List past customers who are due for another visit. A reminder waits for an approved template or Approvals." },
      { id: "review", title: "Review requests", tier: 1, does: "List recent visits that could use a review. Sending the ask still needs your approval." },
    ],
  },
  auto: {
    flow: "job",
    pipeline: ["Dropped off", "Diagnosed", "Waiting on approval", "In the bay", "Ready"],
    brief: ["Cars today", "Waiting on approval", "Due service", "Approvals"],
    metric: "Cars waiting on approval",
    vocabulary: { work: "job", customer: "customer" },
    routines: [
      { id: "morning", title: "Morning briefing", tier: 0, does: "List cars in the shop and what is waiting. Nothing is sent." },
      { id: "due", title: "Due service list", tier: 1, does: "List vehicles that may be due for service. A reminder waits for an approved template or Approvals." },
      { id: "waiting", title: "Waiting on approval", tier: 0, does: "List jobs paused until you approve the work. Nothing is started from this list." },
    ],
  },
  booking_beauty: {
    flow: "appointment",
    pipeline: ["Asked", "Booked", "In the chair", "Done", "Due again"],
    brief: ["Today's book", "Due again", "No-shows", "Approvals"],
    metric: "Appointments today",
    vocabulary: { work: "appointment", customer: "client" },
    routines: [
      { id: "morning", title: "Morning briefing", tier: 0, does: "Read today's book and list it. Nothing is sent." },
      { id: "rebook", title: "Rebooking reminders", tier: 1, does: "List clients who are due for another visit. The text is not sent until a template is approved or a person OKs it." },
      { id: "no_show", title: "No-show list", tier: 0, does: "List missed visits. A follow-up waits for an approved template or Approvals." },
    ],
  },
  quote_velocity: {
    flow: "job",
    pipeline: ["New lead", "Details in", "Quote sent", "Booked", "Done"],
    brief: ["New leads", "Quotes waiting", "Jobs booked", "Approvals"],
    metric: "Quotes waiting",
    vocabulary: { work: "quote", customer: "customer" },
    routines: [
      { id: "morning", title: "Morning briefing", tier: 0, does: "List new requests and quotes that are not out yet. Nothing is sent." },
      { id: "quotes", title: "Quotes waiting", tier: 0, does: "List quotes still waiting for your OK. Nothing is sent from this list." },
      { id: "follow", title: "Quote follow-ups", tier: 1, does: "List people who asked for a quote and have not heard back. Sending the follow-up waits for your approval." },
    ],
  },
  general: {
    flow: "job",
    pipeline: ["New lead", "Talking", "Quoted", "Booked", "Done"],
    brief: ["New leads", "Follow-ups", "Approvals"],
    metric: "New leads",
    vocabulary: { work: "job", customer: "customer" },
    routines: [
      { id: "morning", title: "Morning briefing", tier: 0, does: "Read what changed overnight and list it. Nothing is sent." },
      { id: "follow", title: "Follow-up list", tier: 1, does: "List people waiting on a follow-up. Sending waits for your approval." },
      { id: "review", title: "Review requests", tier: 1, does: "List recent jobs that could use a review. Sending the ask still needs your approval." },
    ],
  },
};

function templatesFor(about: string, deposit: boolean): PackTemplate[] {
  return [
    { purpose: "first_response", channel: "sms", name: "First reply", body: `Hi {{name}}, this is {{business}}. Thanks for reaching out about ${about}. A person here confirms the next step. Reply STOP to opt out.` },
    { purpose: "rebook", channel: "sms", name: "Follow-up", body: `Hi {{name}}, {{business}} can follow up when you approve it. Reply STOP to opt out.` },
    deposit
      ? { purpose: "late_cancel", channel: "sms", name: "Deposit request", body: "Hi {{name}}, {{business}} can request a deposit to hold your time. That request waits for the owner's approval and is never charged automatically. Reply STOP to opt out." }
      : { purpose: "review", channel: "sms", name: "Review request", body: "Hi {{name}}, thanks for choosing {{business}}. A short review helps. Reply STOP to opt out." },
  ];
}

function compose(overlay: Overlay): IndustryPack {
  const base = BASES[overlay.base];
  const pipeline = overlay.pipeline ?? base.pipeline;
  const brief = base.brief;
  const routines = overlay.recall
    ? [
        base.routines[0]!,
        { id: "recall", title: "Recall list", tier: 1 as const, does: "List people due for a return visit using only the name and the last appointment date. No chart is stored. A reminder is not sent until you approve it." },
        base.routines[2]!,
      ]
    : base.routines;
  const services: PackService[] = overlay.services.map((service, i) => ({
    ...service,
    ...(base.flow === "appointment" ? { durationMinutes: service.durationMinutes ?? 45 } : {}),
    priceCents: service.priceCents ?? 4_500 + i * 2_000,
    priceIsExample: true as const,
  }));
  return {
    version: PACK_VERSION,
    id: overlay.id,
    base: overlay.base,
    label: overlay.label,
    group: overlay.group as PackGroup,
    summary: overlay.summary,
    flow: base.flow,
    legacyColumn: overlay.legacyColumn ?? "general",
    trialPlan: overlay.trialPlan ?? "growth",
    vocabulary: base.vocabulary,
    leadFields: base.flow === "appointment" ? visitFields : jobFields,
    services,
    templates: templatesFor(overlay.about, overlay.deposit === true),
    pipeline,
    brief,
    routines,
    integrations: INTEGRATIONS,
    metrics: [
      { id: "morning", label: overlay.metric ?? base.metric },
      { id: "approvals", label: "Approvals waiting" },
    ],
    signals: overlay.signals,
    ...(overlay.seasons ? { seasons: overlay.seasons } : {}),
    ...(overlay.rebookEveryDays ? { rebookEveryDays: overlay.rebookEveryDays } : {}),
    watchLine: overlay.watchLine,
  };
}

export const INDUSTRY_PACKS: readonly IndustryPack[] = OVERLAYS.map(compose);

const BY_ID = new Map(INDUSTRY_PACKS.map((p) => [p.id, p]));

export function listPacks(): readonly IndustryPack[] {
  return INDUSTRY_PACKS;
}

export function getPack(id: string): IndustryPack {
  const p = BY_ID.get(id);
  if (!p) throw new Error(`Unknown industry pack "${id}"`);
  return p;
}

export function isPackId(id: string): boolean {
  return BY_ID.has(id);
}

export function packsUsing(source: SignalSourceId): IndustryPack[] {
  return INDUSTRY_PACKS.filter((p) => p.signals.includes(source));
}

/** Case-insensitive match on the label, group, and summary. Empty query returns every pack. */
export function searchPacks(query: string): IndustryPack[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...INDUSTRY_PACKS];
  return INDUSTRY_PACKS.filter((p) => `${p.label} ${p.group} ${p.summary} ${p.id.replaceAll("_", " ")}`.toLowerCase().includes(q));
}

const CLOSEST: Array<[RegExp, string]> = [
  [/barber/, "barber"],
  [/med spa|medspa|membership/, "med_spa"],
  [/dental|dentist/, "dental"],
  [/junk/, "junk_removal"],
  [/pressure wash/, "pressure_washing"],
  [/vet|veterinar/, "veterinary"],
  [/tax/, "tax_prep"],
  [/tow/, "towing"],
  [/counsel|therap/, "counseling"],
  [/dog|cat|pet|groom|kennel|boarding/, "dog_grooming"],
  [/restaurant|cafe|coffee|bakery|cater|food|bar\b/, "restaurant"],
  [/saas|software|startup|pre-seed|preseed/, "startup_saas"],
  [/agency/, "startup_agency"],
  [/dtc|shopify|product brand/, "startup_dtc"],
  [/yoga|pilates|gym|trainer|fitness/, "yoga_studio"],
  [/child|daycare|preschool|tutor|lesson/, "childcare"],
  [/wedding|event|photo|venue/, "event_planner"],
  [/lawyer|legal|attorney/, "law_office"],
  [/realtor|real estate|broker/, "real_estate"],
  [/retail|store|e-?commerce|online shop/, "retail_shop"],
];

/**
 * The pack to start from when the owner describes a business that is not in the list.
 * A direct search hit is returned as matched. Otherwise the closest known pack, or general.
 */
export function closestPack(words: string): { pack: IndustryPack; matched: boolean } {
  const hits = searchPacks(words);
  if (words.trim() && hits.length && hits.length < INDUSTRY_PACKS.length) return { pack: hits[0]!, matched: true };
  const text = words.toLowerCase();
  for (const [re, id] of CLOSEST) {
    if (re.test(text)) return { pack: getPack(id), matched: false };
  }
  return { pack: getPack("general"), matched: false };
}
