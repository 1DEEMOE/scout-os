import type { Condition, Disclosure, ElitePack, IntakeField, LineRule } from "./schema";

export type Answers = Record<string, string | number | boolean | undefined>;
export type Jurisdiction = "interstate" | "intrastate";

export function matches(c: Condition | undefined, a: Answers): boolean {
  if (!c) return true;
  const v = a[c.field];
  switch (c.op) {
    case "truthy": return Boolean(v);
    case "eq": return v === c.value;
    case "ne": return v !== c.value;
    case "gt": return typeof v === "number" && typeof c.value === "number" && v > c.value;
    case "gte": return typeof v === "number" && typeof c.value === "number" && v >= c.value;
    case "in": return Array.isArray(c.value) && typeof v === "string" && c.value.includes(v);
  }
}

export interface IntakeResult { ok: boolean; missing: string[]; errors: string[]; visible: IntakeField[] }

export function validateIntake(pack: ElitePack, a: Answers): IntakeResult {
  const forbidden = new Set(pack.compliance.forbiddenFields.map((f) => f.toLowerCase()));
  const errors: string[] = [];
  for (const k of Object.keys(a)) if (forbidden.has(k.toLowerCase())) errors.push(`"${k}" must not be stored by this pack`);
  const visible = pack.intake.filter((f) => matches(f.showIf, a));
  const missing: string[] = [];
  for (const f of visible) {
    const v = a[f.id];
    const blank = v === undefined || v === "" || (f.type === "select" && !f.options?.some((o) => o.value === v));
    if (f.required && blank) { missing.push(f.id); continue; }
    if (v !== undefined && f.type === "number") {
      if (typeof v !== "number" || Number.isNaN(v)) errors.push(`${f.id} must be a number`);
      else if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) errors.push(`${f.id} is out of range`);
    }
  }
  return { ok: !missing.length && !errors.length, missing, errors, visible };
}

export interface EstimateLine { id: string; label: string; cents: number; detail: string }
export interface Estimate {
  /** Always a draft. Sending is an approval-gated action, never automatic. */
  status: "draft_needs_approval";
  /** "binding" only when the owner enabled it. Otherwise a non-binding estimate. */
  kind: "binding" | "non_binding";
  priceBasis: "example" | "owner_configured";
  approvalTier: 2 | 3;
  lines: EstimateLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  depositCents: number;
  /** Interstate non-binding only: ceiling a mover may collect at delivery. Verify with counsel. */
  deliveryCollectCapCents?: number;
  warnings: string[];
  blockedReasons: string[];
}

export interface EstimateConfig {
  jurisdiction: Jurisdiction;
  /** True only after the owner replaced the example numbers with their own. */
  ownerConfiguredPrices?: boolean;
  /** Owner switch. Requesting binding without it downgrades to non-binding. */
  ownerAllowsBinding?: boolean;
  requestBinding?: boolean;
  businessProfile?: Record<string, string | undefined>;
  /** Owner-edited rule overrides keyed by rule id. */
  overrides?: Record<string, Partial<{ cents: number; unitCents: number; bps: number }>>;
}

const num = (a: Answers, k: string) => (typeof a[k] === "number" ? (a[k] as number) : 0);

function apply(rule: LineRule, a: Answers, cfg: EstimateConfig): EstimateLine | null {
  if (!matches(rule.when, a)) return null;
  const o = cfg.overrides?.[rule.id] ?? {};
  switch (rule.type) {
    case "fixed": { const c = o.cents ?? rule.cents; return c ? { id: rule.id, label: rule.label, cents: c, detail: "flat" } : null; }
    case "per_unit": {
      const n = num(a, rule.field); const u = o.unitCents ?? rule.unitCents;
      return n > 0 ? { id: rule.id, label: rule.label, cents: Math.round(n * u), detail: `${n} × ${(u / 100).toFixed(2)}` } : null;
    }
    case "hourly_crew": {
      const crew = Math.max(1, Math.floor(num(a, rule.crewField)));
      const hrs = Math.max(rule.minHours, num(a, rule.hoursField));
      const sorted = [...rule.rates].sort((x, y) => x.crew - y.crew);
      const rate = (sorted.filter((r) => r.crew <= crew).pop() ?? sorted[0]!).centsPerHour;
      return { id: rule.id, label: rule.label, cents: Math.round(hrs * rate) + rule.tripFeeCents, detail: `${hrs} h × ${(rate / 100).toFixed(2)}/h + trip fee` };
    }
    case "percent_of_field": {
      const base = num(a, rule.field); const b = o.bps ?? rule.bps;
      return base > 0 ? { id: rule.id, label: rule.label, cents: Math.round((base * 100 * b) / 10000), detail: `${b / 100}% of declared value` } : null;
    }
  }
}

export function buildEstimate(pack: ElitePack, answers: Answers, cfg: EstimateConfig): Estimate {
  const warnings: string[] = [];
  const blockedReasons: string[] = [];
  const intake = validateIntake(pack, answers);
  if (intake.missing.length) blockedReasons.push(`Missing required intake: ${intake.missing.join(", ")}`);
  intake.errors.forEach((e) => blockedReasons.push(e));

  const variant = String(answers[pack.pricing.variantField] ?? "");
  const rules = pack.pricing.variants[variant];
  if (!rules) blockedReasons.push(`No pricing variant for "${variant}"`);

  const lines = [...(rules ?? []), ...pack.pricing.common].map((r) => apply(r, answers, cfg)).filter((l): l is EstimateLine => l !== null);
  const subtotalCents = lines.reduce((s, l) => s + l.cents, 0);
  const taxCents = Math.round((subtotalCents * pack.pricing.taxBps) / 10000);
  const totalCents = subtotalCents + taxCents;
  const depositCents = Math.round((totalCents * pack.pricing.depositBps) / 10000);

  const priceBasis = cfg.ownerConfiguredPrices ? "owner_configured" : "example";
  if (priceBasis === "example") {
    warnings.push("EXAMPLE PRICES: these figures are sample numbers, not your rates. Edit pricing before sending anything to a customer.");
    blockedReasons.push("Prices are still examples. Owner must confirm pricing before an estimate can be sent.");
  }
  let kind: Estimate["kind"] = "non_binding";
  if (cfg.requestBinding) {
    if (cfg.ownerAllowsBinding && priceBasis === "owner_configured") kind = "binding";
    else warnings.push("Binding was requested but the owner has not enabled binding quotes with confirmed prices. Drafted as NON-BINDING.");
  }

  for (const f of pack.compliance.requiredBusinessFields) {
    if ((f.jurisdiction === "all" || f.jurisdiction === cfg.jurisdiction) && !cfg.businessProfile?.[f.id]) {
      blockedReasons.push(`Business profile is missing ${f.label}, required on ${cfg.jurisdiction} documents.`);
    }
  }

  const est: Estimate = {
    status: "draft_needs_approval", kind, priceBasis,
    approvalTier: kind === "binding" ? 3 : 2,
    lines, subtotalCents, taxCents, totalCents, depositCents, warnings, blockedReasons,
  };
  if (kind === "non_binding" && cfg.jurisdiction === "interstate") est.deliveryCollectCapCents = Math.round(totalCents * 1.1);
  return est;
}

export function disclosuresFor(pack: ElitePack, documentId: string, j: Jurisdiction): Disclosure[] {
  return pack.compliance.disclosures.filter((d) => d.appliesTo.includes(documentId) && (d.jurisdiction === "all" || d.jurisdiction === j));
}

/** Plain-text estimate document with required disclosures injected. Still a draft. */
export function renderEstimateText(pack: ElitePack, est: Estimate, ctx: { business: string; customer: string; jurisdiction: Jurisdiction; usdot?: string }): string {
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  const head = est.kind === "binding" ? "BINDING ESTIMATE" : "NON-BINDING ESTIMATE";
  const out = [`${head} — DRAFT, NOT SENT`, `${ctx.business}${ctx.jurisdiction === "interstate" && ctx.usdot ? ` · USDOT ${ctx.usdot}` : ""}`, `Prepared for: ${ctx.customer}`, ""];
  for (const l of est.lines) out.push(`${l.label}: ${usd(l.cents)}  (${l.detail})`);
  out.push("", `Subtotal: ${usd(est.subtotalCents)}`, `Tax: ${usd(est.taxCents)}`, `Total: ${usd(est.totalCents)}`, `Deposit requested: ${usd(est.depositCents)} (a request only; never charged automatically)`);
  if (est.deliveryCollectCapCents) out.push(`Maximum collectible at delivery under a non-binding interstate estimate: ${usd(est.deliveryCollectCapCents)}`);
  if (est.priceBasis === "example") out.push("", "SAMPLE PRICES — not a real quote.");
  const ds = disclosuresFor(pack, "estimate", ctx.jurisdiction);
  if (ds.length) out.push("", "Required notices:", ...ds.map((d) => `- ${d.text}`));
  return out.join("\n");
}
