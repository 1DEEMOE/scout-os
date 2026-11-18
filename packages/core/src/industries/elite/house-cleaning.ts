import { elitePackSchema, type ElitePack, type ElitePackInput } from "./schema";

const opts = (...v: [string, string][]) => v.map(([value, label]) => ({ value, label }));

/**
 * House cleaning — elite pack. Every dollar figure is an EXAMPLE (priceBasis
 * "example"). Recurring-service trade: the intake captures what a good
 * dispatcher asks on the first call, and pricing separates the first deep
 * clean from the recurring visit.
 */
const houseCleaning = {
  eliteVersion: 1,
  id: "house_cleaning",
  intake: [
    { id: "service_kind", label: "Type of clean", type: "select", required: true, options: opts(["recurring", "Recurring clean"], ["deep", "One-time deep clean"], ["moveout", "Move-out clean"]), ask: "Is this a one-time clean or the start of a regular schedule?" },
    { id: "bedrooms", label: "Bedrooms", type: "number", min: 0, max: 12, required: true, ask: "How many bedrooms?" },
    { id: "bathrooms", label: "Bathrooms", type: "number", min: 1, max: 10, required: true, ask: "And how many bathrooms?" },
    { id: "sqft", label: "Approximate square feet", type: "number", min: 200, max: 20000, required: true, ask: "Roughly how many square feet is the home?" },
    { id: "frequency", label: "How often", type: "select", showIf: { field: "service_kind", op: "eq", value: "recurring" }, required: true, options: opts(["weekly", "Weekly"], ["biweekly", "Every two weeks"], ["monthly", "Monthly"]), ask: "Weekly, every two weeks, or monthly?" },
    { id: "occupants", label: "People living there", type: "number", min: 1, max: 20, ask: "How many people live in the home?" },
    { id: "pets", label: "Pets in the home", type: "boolean", ask: "Any pets? It helps the crew plan." },
    { id: "supplies", label: "Who supplies products", type: "select", required: true, options: opts(["we_bring", "We bring everything"], ["customer", "Customer supplies products"]), ask: "Should the crew bring all supplies and equipment?" },
    { id: "condition", label: "Current condition", type: "select", showIf: { field: "service_kind", op: "in", value: ["deep", "moveout"] }, options: opts(["kept", "Well kept"], ["average", "Average"], ["heavy", "Needs heavy work"]), ask: "How would you describe the current condition?" },
    { id: "preferred_date", label: "Preferred first date", type: "date", required: true, ask: "When would you like the first clean?" },
  ],
  pricing: {
    variantField: "service_kind",
    variants: {
      recurring: [{ type: "per_unit", id: "sqft_rate", label: "Recurring clean (per sq ft)", field: "sqft", unitCents: 12 }],
      deep: [{ type: "per_unit", id: "sqft_rate", label: "Deep clean (per sq ft)", field: "sqft", unitCents: 22 }],
      moveout: [
        { type: "per_unit", id: "sqft_rate", label: "Move-out clean (per sq ft)", field: "sqft", unitCents: 25 },
        { type: "fixed", id: "moveout_min", label: "Move-out minimum", cents: 20000 },
      ],
    },
    common: [
      { type: "fixed", id: "supplies_fee", label: "Supplies and equipment", cents: 2500, when: { field: "supplies", op: "eq", value: "we_bring" } },
      { type: "per_unit", id: "heavy_condition", label: "Heavy-condition surcharge (per sq ft)", field: "sqft", unitCents: 8, when: { field: "condition", op: "eq", value: "heavy" } },
    ],
    taxBps: 0,
    depositBps: 0,
    priceBasis: "example",
    bindingAllowedByDefault: false,
  },
  scheduling: {
    model: "crew_equipment",
    resources: [{ kind: "crew", sizes: ["solo", "pair", "team"] }],
    blocks: ["morning", "midday", "afternoon"],
    dispatchRequiresApproval: true,
  },
  documents: [
    { id: "estimate", label: "Service estimate", required: true, jurisdiction: "all", needsSignature: false },
    { id: "service_agreement", label: "Recurring service agreement", required: true, jurisdiction: "all", needsSignature: true },
    { id: "home_access", label: "Home access instructions", required: false, jurisdiction: "all", needsSignature: false },
  ],
  compliance: {
    forbiddenFields: ["gate_code", "alarm_code", "lockbox_code"],
    requiredBusinessFields: [{ id: "business_address", label: "Physical business address", jurisdiction: "all" }],
    approvalFloors: { send_estimate: 2, send_agreement: 2, dispatch_crew: 2, send_invoice: 3 },
    disclosures: [
      { id: "estimate_note", appliesTo: ["estimate"], jurisdiction: "all", text: "This estimate is based on the details provided. If the home's size or condition differs on arrival, the price is re-confirmed with you before work begins.", source: "Owner-configurable estimate policy", legalReview: "pending" },
      { id: "access_note", appliesTo: ["home_access"], jurisdiction: "all", text: "Access instructions (keys, codes) are stored only as long as the service relationship requires. Do not send alarm or gate codes by email or text.", source: "Platform data-minimization policy", legalReview: "pending" },
      { id: "cancellation", appliesTo: ["service_agreement"], jurisdiction: "all", text: "Recurring service can be paused or cancelled with notice before the next scheduled visit. No long-term contract is implied by an estimate.", source: "Owner-configurable cancellation policy", legalReview: "pending" },
    ],
  },
  cadences: [
    { id: "estimate_followup", trigger: "estimate_viewed_no_reply", offsetHours: 48, channel: "email", purpose: "followup", body: "Hi {{name}}, checking in on the cleaning estimate from {{business}}. Happy to adjust the scope or date.", approvalTier: 2, consentCheckedAtSend: true },
    { id: "day_before", trigger: "day_before", offsetHours: -24, channel: "sms", purpose: "reminder", body: "{{business}}: reminder, your clean is tomorrow {{time}}. Reply STOP to opt out.", approvalTier: 2, consentCheckedAtSend: true },
    { id: "review_ask", trigger: "job_done", offsetHours: 24, channel: "email", purpose: "review", body: "Hi {{name}}, thanks for having {{business}} over. A quick review helps a lot: {{review_link}}", approvalTier: 2, consentCheckedAtSend: true },
  ],
  kpis: [
    { id: "recurring_share", label: "Recurring share", definition: "Share of active customers on a recurring schedule." },
    { id: "quote_win_rate", label: "Quote win rate", definition: "Booked cleans divided by estimates sent in the period." },
    { id: "crew_utilization", label: "Crew utilization", definition: "Booked crew-hours divided by available crew-hours." },
  ],
  integrations: ["Google Calendar", "QuickBooks", "Stripe or Square"],
  frontDeskFaq: [
    { q: "How much does a clean cost?", a: "Pricing depends on size, bathrooms, and whether it's a first deep clean or a recurring visit. We'll prepare an estimate for the owner to review." },
    { q: "Do you bring supplies?", a: "The crew can bring all supplies and equipment, or use yours — your choice, and it's reflected in the estimate." },
    { q: "Do I need to be home?", a: "No. Access instructions can be recorded on the service agreement; please don't send alarm or gate codes by text or email." },
    { q: "What about my pets?", a: "Just let us know what pets are in the home so the crew can plan around them." },
  ],
  briefingSections: ["New inquiries waiting for a reply", "Estimates awaiting owner approval", "Cleans today and crew assignments", "Recurring customers due again"],
} satisfies ElitePackInput;

export const HOUSE_CLEANING_ELITE: ElitePack = elitePackSchema.parse(houseCleaning);
