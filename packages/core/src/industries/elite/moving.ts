import { elitePackSchema, type ElitePack, type ElitePackInput } from "./schema";

const opts = (...v: [string, string][]) => v.map(([value, label]) => ({ value, label }));

/**
 * Moving company — elite pack. Every dollar figure is an EXAMPLE (priceBasis "example").
 * Regulatory text below is a drafting aid with legalReview "pending"; it is not legal advice.
 */
const moving = {
  eliteVersion: 1,
  id: "moving",
  intake: [
    { id: "move_type", label: "Local or long-distance", type: "select", required: true, options: opts(["local", "Local"], ["long", "Long-distance / interstate"]), ask: "Is this staying in the area, or going out of state?" },
    { id: "home_size", label: "Home size", type: "select", required: true, options: opts(["studio", "Studio"], ["1br", "1 bedroom"], ["2br", "2 bedroom"], ["3br", "3 bedroom"], ["4br_plus", "4+ bedroom"]), ask: "How many bedrooms, roughly?" },
    { id: "origin_address", label: "Moving from", type: "address", required: true, ask: "What's the address you're moving from?" },
    { id: "dest_address", label: "Moving to", type: "address", required: true, ask: "And where are you moving to?" },
    { id: "move_date", label: "Preferred date", type: "date", required: true, ask: "What day are you hoping to move?" },
    { id: "date_flexible", label: "Date flexible", type: "boolean", ask: "Is that date firm, or can you shift a day or two?" },
    { id: "crew_size", label: "Movers needed", type: "number", min: 2, max: 8, required: true, ask: "Based on size we'd suggest a crew. Any preference?" },
    { id: "est_hours", label: "Estimated hours", type: "number", min: 1, max: 24, ask: "Do you have a sense of how long you'd expect it to take?" },
    { id: "cubic_feet", label: "Estimated cubic feet", type: "number", min: 50, max: 5000, showIf: { field: "move_type", op: "eq", value: "long" }, required: true, ask: "For long-distance we price by volume. Can we do a video walk-through or an inventory list?" },
    { id: "stair_flights", label: "Flights of stairs (total, both ends)", type: "number", min: 0, max: 20, ask: "Any stairs at either address? How many flights?" },
    { id: "long_carry", label: "Long carry (truck far from door)", type: "boolean", ask: "Will the truck be able to park close to the door?" },
    { id: "elevator", label: "Elevator at either address", type: "boolean", ask: "Is there an elevator? We may need to reserve it." },
    { id: "heavy_items", label: "Heavy/specialty items (piano, safe, etc.)", type: "number", min: 0, max: 10, ask: "Any pianos, safes, or very heavy items?" },
    { id: "packing", label: "Packing help", type: "select", options: opts(["none", "None"], ["partial", "Some rooms / fragile"], ["full", "Full packing"]), ask: "Do you want us to pack, or will you be packed?" },
    { id: "boxes", label: "Boxes of packing materials", type: "number", min: 0, max: 500, showIf: { field: "packing", op: "in", value: ["partial", "full"] }, ask: "About how many boxes would you need?" },
    { id: "declared_value", label: "Declared value of goods (USD)", type: "number", min: 0, max: 1000000, ask: "If you want added protection, what's the total value of what's moving?" },
    { id: "valuation", label: "Valuation coverage", type: "select", options: opts(["released", "Released value (basic, included)"], ["full_value", "Full value protection (extra cost)"]), ask: "Basic coverage is included; would you like to price full value protection?" },
  ],
  pricing: {
    variantField: "move_type",
    variants: {
      local: [{ type: "hourly_crew", id: "labor", label: "Crew and truck (hourly)", hoursField: "est_hours", crewField: "crew_size", minHours: 3, tripFeeCents: 10000, rates: [{ crew: 2, centsPerHour: 15000 }, { crew: 3, centsPerHour: 20000 }, { crew: 4, centsPerHour: 25000 }, { crew: 6, centsPerHour: 35000 }] }],
      long: [
        { type: "per_unit", id: "volume", label: "Transportation by volume", field: "cubic_feet", unitCents: 500 },
        { type: "fixed", id: "linehaul_min", label: "Long-distance base charge", cents: 50000 },
      ],
    },
    common: [
      { type: "per_unit", id: "stairs", label: "Stairs fee (per flight)", field: "stair_flights", unitCents: 7500 },
      { type: "fixed", id: "long_carry", label: "Long carry fee", cents: 15000, when: { field: "long_carry", op: "truthy" } },
      { type: "fixed", id: "elevator", label: "Elevator handling", cents: 7500, when: { field: "elevator", op: "truthy" } },
      { type: "per_unit", id: "heavy", label: "Heavy/specialty item", field: "heavy_items", unitCents: 15000 },
      { type: "per_unit", id: "materials", label: "Packing materials (per box)", field: "boxes", unitCents: 400 },
      { type: "fixed", id: "packing_labor", label: "Packing labor (full)", cents: 40000, when: { field: "packing", op: "eq", value: "full" } },
      { type: "percent_of_field", id: "full_value", label: "Full value protection", field: "declared_value", bps: 100, when: { field: "valuation", op: "eq", value: "full_value" } },
    ],
    taxBps: 0,
    depositBps: 2000,
    priceBasis: "example",
    bindingAllowedByDefault: false,
  },
  scheduling: {
    model: "crew_equipment",
    resources: [{ kind: "crew", sizes: ["2", "3", "4", "6"] }, { kind: "truck", sizes: ["16ft", "20ft", "26ft"] }],
    blocks: ["Morning arrival window", "Afternoon arrival window", "Full day", "Multi-day (long distance)"],
    dispatchRequiresApproval: true,
  },
  documents: [
    { id: "estimate", label: "Estimate (binding or non-binding)", required: true, jurisdiction: "all", needsSignature: false },
    { id: "inventory", label: "Inventory / cubic-foot worksheet", required: true, jurisdiction: "all", needsSignature: false },
    { id: "order_for_service", label: "Order for service", required: true, jurisdiction: "interstate", needsSignature: true },
    { id: "bill_of_lading", label: "Bill of lading", required: true, jurisdiction: "interstate", needsSignature: true },
    { id: "valuation_election", label: "Valuation coverage election", required: true, jurisdiction: "all", needsSignature: true },
    { id: "delivery_receipt", label: "Delivery receipt / damage notes", required: true, jurisdiction: "all", needsSignature: true },
  ],
  compliance: {
    forbiddenFields: ["ssn", "card_number", "cvv", "bank_account", "drivers_license", "gate_code", "alarm_code"],
    requiredBusinessFields: [
      { id: "usdot_number", label: "USDOT number", jurisdiction: "interstate" },
      { id: "mc_number", label: "MC operating authority number", jurisdiction: "interstate" },
      { id: "business_address", label: "Physical business address", jurisdiction: "all" },
    ],
    approvalFloors: { send_estimate: 2, send_binding_estimate: 3, request_deposit: 3, dispatch_crew: 2, send_invoice: 3, damage_claim_reply: 3 },
    disclosures: [
      { id: "nonbinding_note", appliesTo: ["estimate"], jurisdiction: "all", text: "This is a non-binding estimate. The final charge depends on actual weight/volume, services performed, and time.", source: "Owner-configurable estimate type", legalReview: "pending" },
      { id: "interstate_booklet", appliesTo: ["estimate", "order_for_service"], jurisdiction: "interstate", text: "Interstate customers must receive the FMCSA consumer booklet describing their rights and responsibilities before the move is booked.", source: "49 CFR Part 375 (FMCSA household goods rules) — verify current text", legalReview: "pending" },
      { id: "interstate_cap", appliesTo: ["estimate"], jurisdiction: "interstate", text: "For a non-binding interstate estimate, the mover is generally limited in what it may require at delivery relative to the estimate. See the FMCSA booklet.", source: "49 CFR 375.405 — verify current text", legalReview: "pending" },
      { id: "valuation", appliesTo: ["estimate", "valuation_election"], jurisdiction: "all", text: "Basic released-value coverage is limited and is not insurance. Full value protection is available at additional cost.", source: "49 CFR 375.201 for interstate; state rules vary for local", legalReview: "pending" },
      { id: "bol", appliesTo: ["bill_of_lading"], jurisdiction: "interstate", text: "A bill of lading is the contract for an interstate move and must be signed and a copy provided to the customer.", source: "49 CFR 375.501 — verify current text", legalReview: "pending" },
    ],
  },
  cadences: [
    { id: "estimate_followup", trigger: "estimate_viewed_no_reply", offsetHours: 48, channel: "email", purpose: "followup", body: "Hi {{name}}, just checking in on the moving estimate from {{business}}. Happy to adjust crew size or date if that helps.", approvalTier: 2, consentCheckedAtSend: true },
    { id: "day_before", trigger: "day_before", offsetHours: -24, channel: "sms", purpose: "reminder", body: "{{business}}: reminder, your move is tomorrow. Crew arrival window: {{crew_arrival_window}}. Reply STOP to opt out.", approvalTier: 2, consentCheckedAtSend: true },
    { id: "review_ask", trigger: "job_done", offsetHours: 24, channel: "email", purpose: "review", body: "Hi {{name}}, thanks for trusting {{business}} with your move. If you have a minute, a review helps a lot: {{review_link}}", approvalTier: 2, consentCheckedAtSend: true },
    { id: "balance_due", trigger: "invoice_due", offsetHours: 0, channel: "email", purpose: "balance", body: "Hi {{name}}, the balance for your move with {{business}} is ready. Nothing is charged automatically.", approvalTier: 3, consentCheckedAtSend: true },
  ],
  kpis: [
    { id: "quote_win_rate", label: "Quote win rate", definition: "Booked moves divided by estimates sent in the period." },
    { id: "speed_to_lead", label: "Speed to first reply", definition: "Median minutes from inquiry to first approved reply." },
    { id: "avg_ticket", label: "Average ticket", definition: "Mean total of completed moves." },
    { id: "crew_utilization", label: "Crew utilization", definition: "Booked crew-hours divided by available crew-hours." },
    { id: "review_rate", label: "Review rate", definition: "Reviews received divided by completed moves." },
  ],
  integrations: ["Google Calendar", "Google Business Profile", "QuickBooks", "Stripe or Square"],
  frontDeskFaq: [
    { q: "How much will my move cost?", a: "Pricing depends on home size, crew, time or volume, and access like stairs. We'll prepare an estimate for the owner to review. It is not binding unless we say so in writing." },
    { q: "Are you licensed and insured?", a: "Ask the owner for the license and USDOT details; we do not state them on the owner's behalf until they are in the business profile." },
    { q: "Do you do long-distance moves?", a: "Yes if the owner offers them; long-distance moves are priced by volume and need an inventory or video walk-through." },
    { q: "Can you pack for me?", a: "Packing can be added: partial or full, plus materials. We'll include it in your estimate." },
    { q: "What if something is damaged?", a: "Tell us right away. Note it on the delivery receipt and the owner will follow up on the claims process." },
  ],
  briefingSections: ["New inquiries waiting for a reply", "Estimates awaiting owner approval", "Moves this week and crew conflicts", "Balances due"],
} satisfies ElitePackInput;

export const MOVING_ELITE: ElitePack = elitePackSchema.parse(moving);
