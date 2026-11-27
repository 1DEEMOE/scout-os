import { elitePackSchema, type ElitePack, type ElitePackInput } from "./schema";

const opts = (...v: [string, string][]) => v.map(([value, label]) => ({ value, label }));

/**
 * Plumbing — elite pack. Every dollar figure is an EXAMPLE (priceBasis
 * "example"). Urgent-trade model: flat diagnostic, per-fixture or hourly
 * repair, and a transparent after-hours fee. Intake triages urgency first —
 * active water damage changes the whole call.
 */
const plumbing = {
  eliteVersion: 1,
  id: "plumbing",
  intake: [
    { id: "visit_kind", label: "What do you need", type: "select", required: true, options: opts(["repair", "Repair visit"], ["install", "Install or replace a fixture"], ["quote", "Larger job quote (repipe, remodel)"]), ask: "Is something broken, are you replacing a fixture, or is it a bigger job?" },
    { id: "urgency", label: "How urgent", type: "select", required: true, options: opts(["emergency", "Active leak / flooding"], ["soon", "This week"], ["planning", "Planning ahead"]), ask: "Is water actively going where it shouldn't?" },
    { id: "issue", label: "What's happening", type: "text", showIf: { field: "visit_kind", op: "ne", value: "quote" }, required: true, ask: "What's going on — leak, clog, no hot water?" },
    { id: "fixtures_count", label: "Fixtures affected", type: "number", min: 1, max: 20, showIf: { field: "visit_kind", op: "ne", value: "quote" }, required: true, ask: "How many fixtures are affected?" },
    { id: "water_shutoff", label: "Main water shut off", type: "boolean", showIf: { field: "urgency", op: "eq", value: "emergency" }, ask: "If water is active: have you shut off the main? If not, do that first." },
    { id: "water_heater_type", label: "Water heater type", type: "select", showIf: { field: "issue", op: "truthy" }, options: opts(["tank", "Tank"], ["tankless", "Tankless"], ["none", "Not heater-related"]), ask: "If it's the water heater: tank or tankless?" },
    { id: "property_type", label: "Property type", type: "select", required: true, options: opts(["house", "House"], ["townhome", "Townhome"], ["condo", "Condo/apartment"], ["commercial", "Small commercial"]), ask: "House, condo, or commercial?" },
    { id: "preferred_date", label: "Preferred date", type: "date", required: true, ask: "When would you like a plumber out?" },
  ],
  pricing: {
    variantField: "visit_kind",
    variants: {
      repair: [
        { type: "fixed", id: "diagnostic", label: "Diagnostic visit (credited toward repair)", cents: 7900 },
        { type: "per_unit", id: "per_fixture", label: "Repair labor (per fixture)", field: "fixtures_count", unitCents: 12500 },
      ],
      install: [{ type: "per_unit", id: "install_per_fixture", label: "Install labor (per fixture, parts billed at cost)", field: "fixtures_count", unitCents: 18500 }],
      quote: [{ type: "fixed", id: "site_visit", label: "On-site scoping visit", cents: 0 }],
    },
    common: [{ type: "fixed", id: "emergency_fee", label: "Emergency dispatch fee", cents: 17500, when: { field: "urgency", op: "eq", value: "emergency" } }],
    taxBps: 0,
    depositBps: 0,
    priceBasis: "example",
    bindingAllowedByDefault: false,
  },
  scheduling: {
    model: "on_call",
    resources: [{ kind: "tech", sizes: ["service", "install"] }],
    blocks: ["8-10", "10-12", "12-2", "2-4", "4-6", "emergency"],
    dispatchRequiresApproval: true,
  },
  documents: [
    { id: "estimate", label: "Service estimate", required: true, jurisdiction: "all", needsSignature: false },
    { id: "work_authorization", label: "Work authorization", required: true, jurisdiction: "all", needsSignature: true },
    { id: "damage_waiver_note", label: "Pre-existing damage note", required: false, jurisdiction: "all", needsSignature: false },
  ],
  compliance: {
    forbiddenFields: ["gate_code", "alarm_code"],
    requiredBusinessFields: [{ id: "business_address", label: "Physical business address", jurisdiction: "all" }],
    approvalFloors: { send_estimate: 2, dispatch_tech: 2, send_invoice: 3 },
    disclosures: [
      { id: "estimate_note", appliesTo: ["estimate"], jurisdiction: "all", text: "This estimate covers the described work. Problems hidden behind walls or under floors are quoted and approved by you before any additional work.", source: "Owner-configurable estimate policy", legalReview: "pending" },
      { id: "emergency_fee", appliesTo: ["estimate"], jurisdiction: "all", text: "Emergency dispatch carries a fee, shown as its own line. Shut off the main water supply before the tech arrives if water is active.", source: "Owner-configurable dispatch policy", legalReview: "pending" },
      { id: "license_note", appliesTo: ["estimate", "work_authorization"], jurisdiction: "all", text: "Plumbing work is performed under the owner's license where the state requires one. Ask the owner for the license number; it is not stated until it is on file.", source: "State licensing rules vary — verify per state", legalReview: "pending" },
    ],
  },
  cadences: [
    { id: "estimate_followup", trigger: "estimate_viewed_no_reply", offsetHours: 24, channel: "email", purpose: "followup", body: "Hi {{name}}, following up on the plumbing estimate from {{business}}. Happy to answer questions or get a visit scheduled.", approvalTier: 2, consentCheckedAtSend: true },
    { id: "day_before", trigger: "day_before", offsetHours: -24, channel: "sms", purpose: "reminder", body: "{{business}}: reminder, your plumber visit is tomorrow {{time}}. Reply STOP to opt out.", approvalTier: 2, consentCheckedAtSend: true },
    { id: "review_ask", trigger: "job_done", offsetHours: 24, channel: "email", purpose: "review", body: "Hi {{name}}, thanks for choosing {{business}}. A quick review helps a lot: {{review_link}}", approvalTier: 2, consentCheckedAtSend: true },
  ],
  kpis: [
    { id: "speed_to_lead", label: "Speed to first reply", definition: "Median minutes from inquiry to first approved reply." },
    { id: "emergency_share", label: "Emergency share", definition: "Share of visits dispatched as emergencies in the period." },
    { id: "quote_win_rate", label: "Quote win rate", definition: "Booked visits divided by estimates sent in the period." },
  ],
  integrations: ["Google Calendar", "QuickBooks", "Stripe or Square"],
  frontDeskFaq: [
    { q: "How much is a service call?", a: "The diagnostic visit has a flat fee that's credited toward the repair. The owner reviews every estimate before it's sent." },
    { q: "Do you handle emergencies?", a: "Yes. If water is actively leaking, shut off the main first; emergency dispatch carries a fee shown on the estimate." },
    { q: "Are you licensed?", a: "Ask the owner for the license number — it is not stated until it is on file in the business profile." },
    { q: "Do you give quotes for bigger jobs?", a: "Bigger jobs like repipes start with an on-site scoping visit so the quote is real." },
  ],
  briefingSections: ["Emergency calls waiting", "Estimates awaiting owner approval", "Visits today and assignments"],
} satisfies ElitePackInput;

export const PLUMBING_ELITE: ElitePack = elitePackSchema.parse(plumbing);
