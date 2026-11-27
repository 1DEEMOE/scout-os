import { elitePackSchema, type ElitePack, type ElitePackInput } from "./schema";

const opts = (...v: [string, string][]) => v.map(([value, label]) => ({ value, label }));

/**
 * HVAC — elite pack. Every dollar figure is an EXAMPLE (priceBasis "example").
 * Urgent-trade model: a diagnostic visit is priced up front, repair hours are
 * estimated, and after-hours calls carry a transparent emergency fee. The
 * intake captures what a dispatcher triages on the phone.
 */
const hvac = {
  eliteVersion: 1,
  id: "hvac",
  intake: [
    { id: "visit_kind", label: "What do you need", type: "select", required: true, options: opts(["repair", "Repair visit"], ["tuneup", "Seasonal tune-up"], ["replace_quote", "Replacement quote"]), ask: "Is the system down, due for a tune-up, or are you looking at replacing it?" },
    { id: "system_type", label: "System type", type: "select", required: true, options: opts(["central_ac", "Central air"], ["furnace", "Furnace"], ["heat_pump", "Heat pump"], ["mini_split", "Mini-split"], ["unknown", "Not sure"]), ask: "What kind of system is it — central air, furnace, heat pump?" },
    { id: "issue", label: "What's happening", type: "text", showIf: { field: "visit_kind", op: "eq", value: "repair" }, required: true, ask: "What's the system doing — or not doing?" },
    { id: "system_age_years", label: "System age (years)", type: "number", min: 0, max: 60, ask: "About how old is the system?" },
    { id: "after_hours", label: "After-hours / weekend", type: "boolean", ask: "Does this need a tech tonight or this weekend? That carries an emergency fee." },
    { id: "property_type", label: "Property type", type: "select", required: true, options: opts(["house", "House"], ["townhome", "Townhome"], ["condo", "Condo/apartment"], ["commercial", "Small commercial"]), ask: "Is this a house, a condo, or a commercial space?" },
    { id: "systems_count", label: "Number of systems", type: "number", min: 1, max: 10, required: true, ask: "How many systems serve the property?" },
    { id: "preferred_date", label: "Preferred date", type: "date", required: true, ask: "When would you like a tech out?" },
  ],
  pricing: {
    variantField: "visit_kind",
    variants: {
      repair: [
        { type: "fixed", id: "diagnostic", label: "Diagnostic visit (credited toward repair)", cents: 8900 },
        { type: "per_unit", id: "repair_hours", label: "Estimated repair labor (per system)", field: "systems_count", unitCents: 14500 },
      ],
      tuneup: [{ type: "per_unit", id: "tuneup_per_system", label: "Tune-up (per system)", field: "systems_count", unitCents: 9900 }],
      replace_quote: [{ type: "fixed", id: "site_survey", label: "On-site replacement survey", cents: 0 }],
    },
    common: [{ type: "fixed", id: "emergency_fee", label: "After-hours emergency fee", cents: 15000, when: { field: "after_hours", op: "truthy" } }],
    taxBps: 0,
    depositBps: 0,
    priceBasis: "example",
    bindingAllowedByDefault: false,
  },
  scheduling: {
    model: "on_call",
    resources: [{ kind: "tech", sizes: ["residential", "commercial"] }],
    blocks: ["8-10", "10-12", "12-2", "2-4", "4-6", "after_hours"],
    dispatchRequiresApproval: true,
  },
  documents: [
    { id: "estimate", label: "Service estimate", required: true, jurisdiction: "all", needsSignature: false },
    { id: "work_authorization", label: "Work authorization", required: true, jurisdiction: "all", needsSignature: true },
    { id: "warranty_note", label: "Parts and labor warranty note", required: false, jurisdiction: "all", needsSignature: false },
  ],
  compliance: {
    forbiddenFields: ["gate_code", "alarm_code"],
    requiredBusinessFields: [{ id: "business_address", label: "Physical business address", jurisdiction: "all" }],
    approvalFloors: { send_estimate: 2, dispatch_tech: 2, send_invoice: 3 },
    disclosures: [
      { id: "estimate_note", appliesTo: ["estimate"], jurisdiction: "all", text: "This estimate covers the described work. Hidden faults found during the repair are quoted and approved by you before any additional work.", source: "Owner-configurable estimate policy", legalReview: "pending" },
      { id: "emergency_fee", appliesTo: ["estimate"], jurisdiction: "all", text: "After-hours and weekend visits carry an emergency fee, shown as its own line. You approve the visit time before a tech is dispatched.", source: "Owner-configurable dispatch policy", legalReview: "pending" },
      { id: "refrigerant", appliesTo: ["estimate", "work_authorization"], jurisdiction: "all", text: "Refrigerant handling is performed only by EPA 608-certified technicians. Ask the owner for certification details.", source: "EPA Clean Air Act Section 608 — verify current rules", legalReview: "pending" },
    ],
  },
  cadences: [
    { id: "estimate_followup", trigger: "estimate_viewed_no_reply", offsetHours: 24, channel: "email", purpose: "followup", body: "Hi {{name}}, following up on the HVAC estimate from {{business}}. Systems don't fix themselves — happy to get a tech scheduled.", approvalTier: 2, consentCheckedAtSend: true },
    { id: "day_before", trigger: "day_before", offsetHours: -24, channel: "sms", purpose: "reminder", body: "{{business}}: reminder, your tech visit is tomorrow {{time}}. Reply STOP to opt out.", approvalTier: 2, consentCheckedAtSend: true },
    { id: "review_ask", trigger: "job_done", offsetHours: 24, channel: "email", purpose: "review", body: "Hi {{name}}, thanks for choosing {{business}}. A quick review helps a lot: {{review_link}}", approvalTier: 2, consentCheckedAtSend: true },
  ],
  kpis: [
    { id: "speed_to_lead", label: "Speed to first reply", definition: "Median minutes from inquiry to first approved reply." },
    { id: "emergency_share", label: "After-hours share", definition: "Share of visits dispatched after hours in the period." },
    { id: "quote_win_rate", label: "Quote win rate", definition: "Booked visits divided by estimates sent in the period." },
  ],
  integrations: ["Google Calendar", "QuickBooks", "Stripe or Square"],
  frontDeskFaq: [
    { q: "How much is a service call?", a: "The diagnostic visit has a flat fee that's credited toward the repair. The owner reviews every estimate before it's sent." },
    { q: "Do you charge more at night or on weekends?", a: "After-hours visits carry an emergency fee, shown as its own line on the estimate before you approve anything." },
    { q: "Can you replace my system?", a: "Replacement starts with an on-site survey so the quote reflects the actual property." },
    { q: "Are your techs certified?", a: "Refrigerant work is done by EPA 608-certified technicians. Ask the owner for current certification details." },
  ],
  briefingSections: ["No-cool / no-heat calls waiting", "Estimates awaiting owner approval", "Tech visits today and assignments", "Tune-ups due this season"],
} satisfies ElitePackInput;

export const HVAC_ELITE: ElitePack = elitePackSchema.parse(hvac);
