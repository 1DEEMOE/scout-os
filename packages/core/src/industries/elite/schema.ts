import { z } from "zod";

/**
 * Elite industry pack extension. Additive: packSchema (v1) is untouched, and an
 * elite pack attaches to an existing overlay by `id`. Bases still supply the shared
 * engine; the elite layer declares what a job in that trade actually involves.
 */

export const ELITE_VERSION = 1 as const;

const slug = z.string().regex(/^[a-z0-9_]+$/);

// ---------- Intake ----------
export const conditionSchema = z.object({
  field: slug,
  op: z.enum(["eq", "ne", "gt", "gte", "in", "truthy"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

export const intakeFieldSchema = z.object({
  id: slug,
  label: z.string().min(2).max(80),
  type: z.enum(["text", "number", "select", "boolean", "date", "address"]),
  required: z.boolean().default(false),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  showIf: conditionSchema.optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** What a good dispatcher says out loud. Feeds the AI front desk. */
  ask: z.string().min(4).max(200),
});
export type IntakeField = z.infer<typeof intakeFieldSchema>;

// ---------- Pricing ----------
const when = conditionSchema.optional();
export const lineRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fixed"), id: slug, label: z.string(), cents: z.number().int().nonnegative(), when }),
  z.object({ type: z.literal("per_unit"), id: slug, label: z.string(), field: slug, unitCents: z.number().int().nonnegative(), when }),
  z.object({
    type: z.literal("hourly_crew"), id: slug, label: z.string(), hoursField: slug, crewField: slug,
    minHours: z.number().positive(), tripFeeCents: z.number().int().nonnegative(),
    rates: z.array(z.object({ crew: z.number().int().positive(), centsPerHour: z.number().int().positive() })).min(1), when,
  }),
  z.object({ type: z.literal("percent_of_field"), id: slug, label: z.string(), field: slug, bps: z.number().int().positive().max(10000), when }),
]);
export type LineRule = z.infer<typeof lineRuleSchema>;

export const pricingModelSchema = z.object({
  /** Which intake answer picks the rule set, e.g. move_type. */
  variantField: slug,
  variants: z.record(z.string(), z.array(lineRuleSchema).min(1)),
  /** Shared rules applied to every variant (fees, packing, valuation). */
  common: z.array(lineRuleSchema),
  taxBps: z.number().int().min(0).max(2500).default(0),
  depositBps: z.number().int().min(0).max(10000),
  /** Every figure is an example until the owner edits and confirms it. */
  priceBasis: z.literal("example"),
  /** Binding quotes only exist if the owner enables them. Default is non-binding. */
  bindingAllowedByDefault: z.literal(false),
});
export type PricingModel = z.infer<typeof pricingModelSchema>;

// ---------- Scheduling, documents, compliance ----------
export const schedulingSchema = z.object({
  model: z.enum(["slot", "block", "multi_day", "crew_equipment", "route", "on_call"]),
  resources: z.array(z.object({ kind: z.enum(["crew", "truck", "tech", "bay", "room"]), sizes: z.array(z.string()).min(1) })),
  blocks: z.array(z.string()).min(1),
  /** Hard rule: nothing is dispatched or confirmed without a person. */
  dispatchRequiresApproval: z.literal(true),
});

export const disclosureSchema = z.object({
  id: slug,
  appliesTo: z.array(slug).min(1),
  jurisdiction: z.enum(["all", "interstate", "intrastate"]),
  text: z.string().min(20),
  source: z.string().min(4),
  /** Never "approved" from code. A lawyer signs off per state. */
  legalReview: z.literal("pending"),
});
export type Disclosure = z.infer<typeof disclosureSchema>;

export const documentSchema = z.object({
  id: slug,
  label: z.string(),
  required: z.boolean(),
  jurisdiction: z.enum(["all", "interstate", "intrastate"]),
  needsSignature: z.boolean(),
});

export const complianceSchema = z.object({
  forbiddenFields: z.array(z.string().min(2)).min(1),
  /** Business-profile values that must be set before a document can be drafted. */
  requiredBusinessFields: z.array(z.object({ id: slug, label: z.string(), jurisdiction: z.enum(["all", "interstate", "intrastate"]) })),
  /** Approval floors per action. Never below tier 2 for anything external. */
  approvalFloors: z.record(z.string(), z.number().int().min(2).max(4)),
  disclosures: z.array(disclosureSchema).min(1),
});

// ---------- Cadences, KPIs, starter content ----------
export const ALLOWED_PLACEHOLDERS = ["name", "business", "date", "time", "crew_arrival_window", "review_link"] as const;

export const cadenceSchema = z.object({
  id: slug,
  trigger: z.enum(["estimate_sent", "estimate_viewed_no_reply", "booked", "day_before", "job_done", "invoice_due", "dormant_12m"]),
  offsetHours: z.number().int(),
  channel: z.enum(["email", "sms"]),
  purpose: z.enum(["first_response", "rebook", "no_show", "late_cancel", "review", "followup", "reminder", "balance", "winback"]),
  body: z.string().min(8).max(500),
  /** Cadence sends always pass consent, suppression, and quiet hours at send time. */
  approvalTier: z.number().int().min(2).max(4),
  consentCheckedAtSend: z.literal(true),
});

export const kpiSchema = z.object({ id: slug, label: z.string(), definition: z.string().min(10) });

export const elitePackSchema = z.object({
  eliteVersion: z.literal(ELITE_VERSION),
  id: slug,
  intake: z.array(intakeFieldSchema).min(6),
  pricing: pricingModelSchema,
  scheduling: schedulingSchema,
  documents: z.array(documentSchema).min(3),
  compliance: complianceSchema,
  cadences: z.array(cadenceSchema).min(3),
  kpis: z.array(kpiSchema).min(3).max(6),
  integrations: z.array(z.string().min(2)).min(2),
  frontDeskFaq: z.array(z.object({ q: z.string().min(6), a: z.string().min(10) })).min(4),
  briefingSections: z.array(z.string().min(3)).min(3),
}).superRefine((p, ctx) => {
  for (const c of p.cadences) {
    const bad = [...c.body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).filter((k) => !(ALLOWED_PLACEHOLDERS as readonly string[]).includes(k ?? ""));
    if (bad.length) ctx.addIssue({ code: "custom", message: `cadence ${c.id} uses unknown placeholder(s): ${bad.join(", ")}` });
    if (c.channel === "sms" && !/STOP/.test(c.body)) ctx.addIssue({ code: "custom", message: `sms cadence ${c.id} must carry STOP opt-out text` });
  }
  const ids = new Set(p.intake.map((f) => f.id));
  const refs = (r: LineRule) => [r.when?.field, "field" in r ? r.field : undefined, "hoursField" in r ? r.hoursField : undefined, "crewField" in r ? r.crewField : undefined];
  for (const r of [...Object.values(p.pricing.variants).flat(), ...p.pricing.common]) {
    for (const f of refs(r)) if (f && !ids.has(f)) ctx.addIssue({ code: "custom", message: `pricing rule ${r.id} references unknown intake field ${f}` });
  }
  if (!ids.has(p.pricing.variantField)) ctx.addIssue({ code: "custom", message: "pricing.variantField is not an intake field" });
});
export type ElitePack = z.infer<typeof elitePackSchema>;
/** Authoring shape: defaults (e.g. intake `required`) are optional here and filled on parse. */
export type ElitePackInput = z.input<typeof elitePackSchema>;
