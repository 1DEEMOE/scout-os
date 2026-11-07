/**
 * Industry packs are configuration, not code forks. One record describes how a
 * local shop talks about its work, which signals apply, and whether the work
 * is a job/quote or an appointment. Adding a trade means adding a record here
 * or a row in catalog.ts.
 */

import { CATALOG, type CatalogRow } from "./catalog";

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
  /** What the owner would connect later. The pack does not connect it. */
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
  /** Names the owner sees. Editable later; not a second pipeline engine. */
  pipeline: string[];
  /** Morning layout, in order. Reads only (tier 0). */
  brief: string[];
  routines: PackRoutine[];
  integrations: PackIntegration[];
  metrics: PackMetric[];
  signals: readonly SignalSourceId[];
  /** Month is 1–12. A note, not a prediction. */
  seasons?: { month: number; label: string }[];
  /** Days after the last completed visit before a rebook reminder is due. */
  rebookEveryDays?: { serviceId: string; days: number; label: string }[];
  watchLine: string;
}

const first = (name: string, channel: "email" | "sms", body: string): PackTemplate => ({
  purpose: "first_response",
  channel,
  name,
  body,
});

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

type Draft = Omit<IndustryPack, "version" | "flow" | "leadFields" | "vocabulary" | "services" | "routines" | "brief" | "pipeline" | "integrations" | "metrics"> & {
  vocabulary?: IndustryPack["vocabulary"];
  services: Omit<PackService, "priceIsExample">[];
  pipeline?: string[];
  brief?: string[];
  integrations?: PackIntegration[];
  metrics?: PackMetric[];
};

const DEFAULT_INTEGRATIONS: PackIntegration[] = [
  { kind: "calendar", label: "Calendar", note: "Suggested only. A booking is not written until you connect a calendar and approve the change." },
  { kind: "crm", label: "CRM", note: "Suggested only. A handoff waits for your OK. Nothing is written by itself." },
  { kind: "accounting", label: "Accounting", note: "Suggested only. No invoice is sent and nothing is paid automatically." },
];

/** Trade-named pipeline and the morning list. Versioned with PACK_VERSION. */
const TRADE: Record<string, { pipeline: string[]; brief: string[] }> = {
  roofing: { pipeline: ["New lead", "Inspection set", "Quote sent", "Job scheduled", "Done"], brief: ["Weather in your area", "New leads", "Quotes waiting", "Jobs today", "Approvals"] },
  general: { pipeline: ["New lead", "Talking", "Quoted", "Booked", "Done"], brief: ["New leads", "Follow-ups", "Invoices", "Approvals"] },
  landscaping: { pipeline: ["New lead", "Estimate", "Scheduled", "On the route", "Done"], brief: ["Season", "New leads", "Routes today", "Who is due again", "Approvals"] },
  plumbing: { pipeline: ["New lead", "Call scheduled", "On site", "Quote", "Done"], brief: ["New leads", "Calls today", "Open quotes", "Approvals"] },
  construction: { pipeline: ["New lead", "Site visit", "Bid sent", "Scheduled", "Done"], brief: ["New leads", "Bids out", "Jobs this week", "Approvals"] },
  hvac: { pipeline: ["New lead", "Tune-up booked", "Diagnosed", "Repair approved", "Done"], brief: ["Season", "Weather", "Tune-ups due", "Calls today", "Approvals"] },
  electrical: { pipeline: ["New lead", "Call scheduled", "On site", "Quote", "Done"], brief: ["New leads", "Calls today", "Open quotes", "Approvals"] },
  pest_control: { pipeline: ["New lead", "First visit", "On a plan", "Due again", "Paused"], brief: ["Season", "New leads", "Due for service", "Approvals"] },
  tire_shop: { pipeline: ["New lead", "Appointment", "In the bay", "Ready", "Picked up"], brief: ["Appointments today", "Rotations due", "Approvals"] },
  auto_repair: { pipeline: ["New lead", "Dropped off", "Diagnosed", "Approved", "Ready"], brief: ["Cars today", "Oil changes due", "Waiting on approval", "Approvals"] },
  auto_glass: { pipeline: ["New lead", "Scheduled", "In the bay", "Done"], brief: ["Weather", "New leads", "Glass jobs today", "Approvals"] },
  moving: { pipeline: ["New lead", "Survey", "Booked", "Move day", "Done"], brief: ["New leads", "Moves this week", "Approvals"] },
  duct_cleaning: { pipeline: ["New lead", "Scheduled", "On site", "Done"], brief: ["New leads", "Yearly reminders", "Visits today", "Approvals"] },
  tree_service: { pipeline: ["New lead", "Estimate", "Scheduled", "Done"], brief: ["Weather", "New leads", "Jobs today", "Approvals"] },
  nail_salon: { pipeline: ["Asked", "Booked", "In the chair", "Done", "Due for a fill"], brief: ["Today's book", "Fills due", "No-shows", "Approvals"] },
  hair_salon: { pipeline: ["Asked", "Booked", "In the chair", "Done", "Due for a cut"], brief: ["Today's chairs", "Cuts due", "No-shows", "Approvals"] },
  esthetics: { pipeline: ["Asked", "Booked", "In the room", "Done", "Due again"], brief: ["Today's book", "Facials due", "Approvals"] },
  lash_brow: { pipeline: ["Asked", "Booked", "In the chair", "Done", "Due for a fill"], brief: ["Today's book", "Fills due", "No-shows", "Approvals"] },
};

function routinesFor(flow: WorkFlow): PackRoutine[] {
  const common: PackRoutine[] = [
    { id: "morning", title: "Morning briefing", tier: 0, does: "Read what changed overnight and list it. Nothing is sent." },
    { id: "review", title: "Review requests", tier: 1, does: "List recent visits that could use a review. Sending the ask still needs an approved template or Approvals." },
  ];
  if (flow === "appointment") {
    return [
      ...common,
      { id: "rebook", title: "Rebooking reminders", tier: 1, does: "List clients who are due for another visit. The text is not sent until a template is approved or a person OKs it." },
      { id: "no_show", title: "No-show and late-cancel list", tier: 0, does: "List missed or late-cancelled visits. A follow-up text waits for an approved template or Approvals." },
    ];
  }
  return [
    ...common,
    { id: "reservice", title: "Re-service reminders", tier: 1, does: "List past customers who are due again. Sending waits for an approved template or Approvals." },
  ];
}

function finish(flow: WorkFlow, leadFields: IndustryPack["leadFields"], vocabulary: IndustryPack["vocabulary"], draft: Draft): IndustryPack {
  const trade = TRADE[draft.id] ?? (draft.pipeline && draft.brief ? { pipeline: draft.pipeline, brief: draft.brief } : undefined);
  if (!trade) throw new Error(`Pack ${draft.id} has no pipeline or morning layout`);
  const brief = draft.brief ?? trade.brief;
  return {
    ...draft,
    version: PACK_VERSION,
    flow,
    leadFields,
    vocabulary,
    routines: routinesFor(flow),
    integrations: draft.integrations ?? DEFAULT_INTEGRATIONS,
    metrics: draft.metrics ?? brief.slice(0, 4).map((label, i) => ({ id: `brief_${i}`, label })),
    services: draft.services.map((s, i) => ({ ...s, priceCents: s.priceCents ?? 7_500 + i * 2_500, priceIsExample: true as const })),
    pipeline: draft.pipeline ?? trade.pipeline,
    brief,
  };
}

function job(p: Draft): IndustryPack {
  return finish("job", jobFields, p.vocabulary ?? { work: "job", customer: "customer" }, p);
}

function visit(p: Omit<Draft, "legacyColumn" | "trialPlan">): IndustryPack {
  return finish("appointment", visitFields, { work: "appointment", customer: "client" }, { ...p, legacyColumn: "general", trialPlan: "growth" });
}

const reply = (trade: string) =>
  first("First reply", "sms", `Hi {{name}}, this is {{business}}. Thanks for reaching out about ${trade}. We'll confirm a time shortly. Reply STOP to opt out.`);

function fromCatalog(row: CatalogRow): IndustryPack {
  const templates: PackTemplate[] = [reply(row.about)];
  if (row.flow === "appointment") {
    templates.push(
      { purpose: "rebook", channel: "sms", name: "Due again", body: `Hi {{name}}, it may be time to book again at {{business}}. Reply STOP to opt out.` },
      { purpose: "no_show", channel: "sms", name: "Missed visit", body: `Hi {{name}}, we missed you at {{business}}. Reply if you'd like another time. Reply STOP to opt out.` },
    );
  }
  const shared = {
    id: row.id,
    label: row.label,
    group: row.group as PackGroup,
    summary: row.summary,
    services: row.services,
    templates,
    signals: row.signals,
    watchLine: row.watchLine,
    pipeline: row.pipeline,
    brief: row.brief,
    seasons: row.seasons,
    rebookEveryDays: row.rebookEveryDays,
  };
  return row.flow === "appointment" ? visit(shared) : job({ ...shared, legacyColumn: "general", trialPlan: "growth" });
}

const BASE_PACKS: readonly IndustryPack[] = [
  job({
    id: "roofing",
    label: "Roofing",
    group: "Home services",
    summary: "Quotes and jobs. Weather is one signal, not the whole business.",
    legacyColumn: "roofing",
    trialPlan: "scout_pro",
    services: [
      { id: "repair", label: "Repair" },
      { id: "replacement", label: "Replacement" },
      { id: "inspection", label: "Inspection" },
    ],
    templates: [reply("your roof")],
    signals: ["weather", "seasonal", "new_mover"],
    seasons: [{ month: 4, label: "Spring inspection season" }, { month: 9, label: "Fall inspection season" }],
    watchLine: "new leads, quotes, and weather warnings in your service area",
  }),
  job({
    id: "general",
    label: "Another local business",
    group: "Other",
    summary: "Leads, follow-ups, invoices, and approvals. No trade-specific signals.",
    legacyColumn: "general",
    trialPlan: "growth",
    services: [{ id: "service", label: "Service call" }],
    templates: [reply("your request")],
    signals: ["reservice"],
    watchLine: "new leads, follow-ups, invoices, and anything waiting for your OK",
  }),
  job({
    id: "landscaping",
    label: "Landscaping",
    group: "Home services",
    summary: "Mowing, cleanups, and spring start-ups.",
    legacyColumn: "general",
    trialPlan: "growth",
    services: [
      { id: "mow", label: "Mowing" },
      { id: "cleanup", label: "Seasonal cleanup" },
    ],
    templates: [reply("your yard")],
    signals: ["seasonal", "reservice"],
    seasons: [{ month: 3, label: "Spring cleanup season" }, { month: 10, label: "Leaf season" }],
    rebookEveryDays: [{ serviceId: "mow", days: 14, label: "Mowing is often every couple of weeks in season" }],
    watchLine: "new leads and seasonal yard work",
  }),
  job({
    id: "plumbing",
    label: "Plumbing",
    group: "Home services",
    summary: "Service calls and quotes.",
    legacyColumn: "general",
    trialPlan: "growth",
    services: [
      { id: "service", label: "Service call" },
      { id: "water_heater", label: "Water heater" },
    ],
    templates: [reply("plumbing")],
    signals: ["reservice", "new_mover"],
    rebookEveryDays: [{ serviceId: "water_heater", days: 365, label: "Water heater flush about once a year" }],
    watchLine: "new leads and service reminders",
  }),
  job({
    id: "construction",
    label: "Construction",
    group: "Home services",
    summary: "Bids and jobs. Permit notices are a mock signal until a live feed exists.",
    legacyColumn: "general",
    trialPlan: "growth",
    services: [{ id: "bid", label: "Bid" }, { id: "remodel", label: "Remodel" }],
    templates: [reply("your project")],
    signals: ["permit", "new_mover"],
    watchLine: "new leads and permit-style notices (sample data until a live feed is connected)",
  }),
  job({
    id: "hvac",
    label: "HVAC",
    group: "Home services",
    summary: "Tune-ups and repairs. Weather and the pre-summer calendar both apply.",
    legacyColumn: "general",
    trialPlan: "growth",
    services: [
      { id: "tuneup", label: "Tune-up" },
      { id: "repair", label: "Repair" },
    ],
    templates: [reply("heating or cooling")],
    signals: ["weather", "seasonal", "reservice"],
    seasons: [{ month: 4, label: "Pre-summer cooling tune-ups" }, { month: 9, label: "Pre-winter heating tune-ups" }],
    rebookEveryDays: [{ serviceId: "tuneup", days: 180, label: "Tune-up about twice a year" }],
    watchLine: "new leads, tune-up season, and weather warnings",
  }),
  job({
    id: "electrical",
    label: "Electrician",
    group: "Home services",
    summary: "Service calls and panel work.",
    legacyColumn: "general",
    trialPlan: "growth",
    services: [{ id: "service", label: "Service call" }, { id: "panel", label: "Panel" }],
    templates: [reply("electrical work")],
    signals: ["reservice", "new_mover"],
    watchLine: "new leads and service reminders",
  }),
  job({
    id: "pest_control",
    label: "Pest control",
    group: "Home services",
    summary: "Seasonal pressure and quarterly service.",
    legacyColumn: "general",
    trialPlan: "growth",
    services: [{ id: "quarterly", label: "Quarterly service" }],
    templates: [reply("pest control")],
    signals: ["seasonal", "reservice"],
    seasons: [{ month: 4, label: "Spring pest season" }, { month: 7, label: "Peak summer" }],
    rebookEveryDays: [{ serviceId: "quarterly", days: 90, label: "Quarterly service" }],
    watchLine: "new leads and who is due for another visit",
  }),
  job({
    id: "tire_shop",
    label: "Tire shop",
    group: "Shops",
    summary: "Tires and rotations.",
    legacyColumn: "general",
    trialPlan: "growth",
    services: [{ id: "tires", label: "Tires" }, { id: "rotation", label: "Rotation" }],
    templates: [reply("your vehicle")],
    signals: ["reservice", "seasonal"],
    seasons: [{ month: 10, label: "Winter tire season" }],
    rebookEveryDays: [{ serviceId: "rotation", days: 180, label: "Rotation about every six months" }],
    watchLine: "new leads and rotation reminders",
  }),
  job({
    id: "auto_repair",
    label: "Auto repair",
    group: "Shops",
    summary: "Repairs and oil changes.",
    legacyColumn: "general",
    trialPlan: "growth",
    services: [{ id: "oil", label: "Oil change" }, { id: "repair", label: "Repair" }],
    templates: [reply("your car")],
    signals: ["reservice"],
    rebookEveryDays: [{ serviceId: "oil", days: 120, label: "Oil change often due in a few months" }],
    watchLine: "new leads and oil-change reminders",
  }),
  job({
    id: "auto_glass",
    label: "Auto glass",
    group: "Shops",
    summary: "Chip and glass repair. Storms are one signal.",
    legacyColumn: "general",
    trialPlan: "growth",
    services: [{ id: "chip", label: "Chip repair" }, { id: "replacement", label: "Glass replacement" }],
    templates: [reply("your glass")],
    signals: ["weather", "reservice"],
    watchLine: "new leads and weather that can chip glass",
  }),
  job({
    id: "moving",
    label: "Moving company",
    group: "Shops",
    summary: "Moves. New-mover notices are sample data until a live feed exists.",
    legacyColumn: "general",
    trialPlan: "growth",
    services: [{ id: "local", label: "Local move" }, { id: "long", label: "Long-distance move" }],
    templates: [reply("your move")],
    signals: ["new_mover"],
    watchLine: "new leads and sample new-mover notices",
  }),
  job({
    id: "duct_cleaning",
    label: "Duct cleaning",
    group: "Home services",
    summary: "A visit about once a year.",
    legacyColumn: "general",
    trialPlan: "growth",
    services: [{ id: "ducts", label: "Duct cleaning" }],
    templates: [reply("your ducts")],
    signals: ["reservice", "seasonal"],
    seasons: [{ month: 3, label: "Spring cleaning season" }],
    rebookEveryDays: [{ serviceId: "ducts", days: 365, label: "Yearly duct cleaning" }],
    watchLine: "new leads and yearly reminders",
  }),
  job({
    id: "tree_service",
    label: "Tree service",
    group: "Home services",
    summary: "Trimming and storm cleanup. Weather is one signal.",
    legacyColumn: "general",
    trialPlan: "growth",
    services: [{ id: "trim", label: "Trim" }, { id: "removal", label: "Removal" }],
    templates: [reply("your trees")],
    signals: ["weather", "seasonal"],
    seasons: [{ month: 3, label: "Spring pruning" }],
    watchLine: "new leads and weather that downs limbs",
  }),
  visit({
    id: "nail_salon",
    label: "Nail salon",
    group: "Beauty & personal care",
    summary: "Booking-first. Fills are often every 2–3 weeks. No medical claims.",
    services: [
      { id: "manicure", label: "Manicure", durationMinutes: 45, priceCents: 3500 },
      { id: "fill", label: "Fill", durationMinutes: 60, priceCents: 5500 },
    ],
    templates: [
      reply("your appointment"),
      { purpose: "rebook", channel: "sms", name: "Fill reminder", body: "Hi {{name}}, it's been a few weeks. {{business}} can book your next fill. Reply STOP to opt out." },
      { purpose: "no_show", channel: "sms", name: "Missed visit", body: "Hi {{name}}, we missed you at {{business}}. Reply if you'd like another time. Reply STOP to opt out." },
      { purpose: "late_cancel", channel: "sms", name: "Late cancel", body: "Hi {{name}}, {{business}} released your time. Reply if you'd like to rebook. Reply STOP to opt out." },
      { purpose: "review", channel: "sms", name: "Review request", body: "Hi {{name}}, thanks for visiting {{business}}. If you have a minute, a review helps. Reply STOP to opt out." },
    ],
    signals: ["reservice"],
    rebookEveryDays: [{ serviceId: "fill", days: 18, label: "Fills are often every 2–3 weeks" }],
    watchLine: "today's book, who is due for a fill, and no-shows",
  }),
  visit({
    id: "hair_salon",
    label: "Hair salon or barber",
    group: "Beauty & personal care",
    summary: "Chairs and appointments. Haircuts are often every 4–6 weeks.",
    services: [
      { id: "cut", label: "Haircut", durationMinutes: 45, priceCents: 4500 },
      { id: "color", label: "Color", durationMinutes: 120, priceCents: 14000 },
    ],
    templates: [
      reply("your appointment"),
      { purpose: "rebook", channel: "sms", name: "Haircut reminder", body: "Hi {{name}}, it may be time for a cut at {{business}}. Reply STOP to opt out." },
      { purpose: "no_show", channel: "sms", name: "Missed visit", body: "Hi {{name}}, we held a chair at {{business}} and didn't see you. Reply to rebook. Reply STOP to opt out." },
      { purpose: "review", channel: "sms", name: "Review request", body: "Hi {{name}}, thanks for sitting with {{business}}. A short review helps. Reply STOP to opt out." },
    ],
    signals: ["reservice"],
    rebookEveryDays: [{ serviceId: "cut", days: 35, label: "Haircuts are often every 4–6 weeks" }],
    watchLine: "today's chairs, haircut reminders, and no-shows",
  }),
  visit({
    id: "esthetics",
    label: "Esthetics (non-medical)",
    group: "Beauty & personal care",
    summary: "Facials and brows. Not a medical practice and not a med-spa procedure.",
    services: [
      { id: "facial", label: "Facial", durationMinutes: 60, priceCents: 9000 },
      { id: "brow", label: "Brow wax", durationMinutes: 20, priceCents: 2000 },
    ],
    templates: [
      reply("your visit"),
      { purpose: "rebook", channel: "sms", name: "Facial reminder", body: "Hi {{name}}, {{business}} can book your next facial. Reply STOP to opt out." },
      { purpose: "review", channel: "sms", name: "Review request", body: "Hi {{name}}, thanks for visiting {{business}}. Reply STOP to opt out." },
    ],
    signals: ["reservice"],
    rebookEveryDays: [{ serviceId: "facial", days: 28, label: "Facials are often about monthly" }],
    watchLine: "today's book and who is due for another facial",
  }),
  visit({
    id: "lash_brow",
    label: "Lash and brow",
    group: "Beauty & personal care",
    summary: "Fills every few weeks. Not a medical service.",
    services: [
      { id: "lash_fill", label: "Lash fill", durationMinutes: 60, priceCents: 6500 },
      { id: "brow", label: "Brow lamination", durationMinutes: 45, priceCents: 7000 },
    ],
    templates: [
      reply("your appointment"),
      { purpose: "rebook", channel: "sms", name: "Lash fill reminder", body: "Hi {{name}}, lash fills at {{business}} are often every 2–3 weeks. Reply STOP to opt out." },
      { purpose: "no_show", channel: "sms", name: "Missed visit", body: "Hi {{name}}, we missed you at {{business}}. Reply to rebook. Reply STOP to opt out." },
    ],
    signals: ["reservice"],
    rebookEveryDays: [{ serviceId: "lash_fill", days: 18, label: "Lash fills are often every 2–3 weeks" }],
    watchLine: "today's book and lash-fill reminders",
  }),
];

export const INDUSTRY_PACKS: readonly IndustryPack[] = [...BASE_PACKS, ...CATALOG.map(fromCatalog)];

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
  [/dog|cat|pet|groom|kennel|boarding/, "dog_grooming"],
  [/restaurant|cafe|coffee|bakery|cater|food|bar\b/, "restaurant"],
  [/saas|software|startup|pre-seed|preseed/, "startup_saas"],
  [/agency|studio/, "startup_agency"],
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
