/**
 * Guardrail eval checks — deterministic verification of the platform's
 * injection defenses. No model, no database, no network. See run.ts.
 *
 * What each suite proves:
 *  1. taint      — a value planted in external text forces the step to need approval
 *  2. wrapping   — externalData() output cannot be closed early by the wrapped text
 *  3. policy     — tier matrix: 0–1 run, 2–3 one approval, 4 two confirmations; unknown tools denied
 *  4. payment    — payment-detail tools can never evaluate below tier 3
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { externalData } from "../src/engine/orchestrator";
import { evaluatePolicy, taintedArgs, type AgentGrant } from "../src/engine/policy";
import { enforcePaymentDetailTier, PAYMENT_DETAIL_MIN_TIER, PAYMENT_DETAIL_TOOLS } from "../src/finance/payment-guard";
import type { AnyTool, Tier } from "../src/engine/tools";

interface TaintCase {
  id: string;
  source: string;
  text: string;
  plantedValues: string[];
  expectTagEscaped?: boolean;
}
interface Fixtures {
  sources: string[];
  taintCases: TaintCase[];
}

const fixtures = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "injection-fixtures.json"), "utf8"),
) as Fixtures;

export interface EvalResult { suite: string; id: string; pass: boolean; detail: string }

export function runGuardrailChecks(): EvalResult[] {
  const results: EvalResult[] = [];
  const check = (suite: string, id: string, pass: boolean, detail: string) => results.push({ suite, id, pass, detail });

  const tool = (name: string, tier: Tier): AnyTool =>
    ({ name, description: name, tier, args: { safeParse: (v: unknown) => ({ success: true, data: v }) }, summarize: () => name, execute: async () => ({}) }) as unknown as AnyTool;

  const fullGrant: AgentGrant = {
    allowlist: ["mail.send", "finance.update_payment_destination", "data.read", "db.purge"],
    maxTier: new Map([
      ["mail.send", 4],
      ["finance.update_payment_destination", 4],
      ["data.read", 4],
      ["db.purge", 4],
    ]),
  };

  // 1. Taint: every planted value in args must be detected against its source text.
  for (const c of fixtures.taintCases) {
    for (const planted of c.plantedValues) {
      const tainted = taintedArgs({ to: [planted], note: "ok" }, c.text);
      check("taint", `${c.id}: ${planted}`, tainted.length > 0, tainted.length ? `tainted paths: ${tainted.join(",")}` : "NOT DETECTED");
    }
    if (c.plantedValues.length === 0) {
      check("taint", c.id, true, "instruction-only text carries no plantable value (defense is the preamble + policy, not parsing)");
    }
  }

  // 2. Wrapping: no closing tag in the wrapped output other than the final one.
  for (const c of fixtures.taintCases.filter((c) => c.expectTagEscaped)) {
    const wrapped = externalData(c.source, c.text);
    const closings = wrapped.split("</external_data>").length - 1;
    check("wrapping", c.id, closings === 1 && wrapped.trim().endsWith("</external_data>"), `closing tags after wrap: ${closings}`);
  }

  // 3. Policy matrix.
  const matrix: { name: string; tier: Tier; want: string }[] = [
    { name: "data.read", tier: 0, want: "allow" },
    { name: "mail.send", tier: 2, want: "needs_approval:1" },
    { name: "mail.send", tier: 3, want: "needs_approval:1" },
    { name: "db.purge", tier: 4, want: "needs_approval:2" },
  ];
  for (const m of matrix) {
    const d = evaluatePolicy(tool(m.name, m.tier), m.name, fullGrant);
    const got = d.kind === "needs_approval" ? `needs_approval:${d.confirmations}` : d.kind;
    check("policy", `${m.name}@tier${m.tier}`, got === m.want, `${got} (want ${m.want})`);
  }
  {
    const d = evaluatePolicy(tool("nonexistent", 1), "nonexistent", fullGrant);
    check("policy", "unknown tool denied", d.kind === "deny", d.kind);
  }
  {
    const d = evaluatePolicy(tool("mail.send", 4), "mail.send", { allowlist: ["mail.send"], maxTier: new Map([["mail.send", 2]]) });
    check("policy", "grant ceiling enforced", d.kind === "deny", d.kind);
  }

  // 4. Payment floor: even a tier-1-registered payment tool must surface as >= tier 3.
  for (const name of PAYMENT_DETAIL_TOOLS) {
    const steps = [{ index: 0, tool: name, args: {}, tier: 1 as Tier, summary: "x", digest: "d", decision: "allow" as const }];
    const raised = enforcePaymentDetailTier(steps);
    check("payment", name, raised[0]!.tier >= PAYMENT_DETAIL_MIN_TIER, `effective tier ${raised[0]!.tier} (floor ${PAYMENT_DETAIL_MIN_TIER})`);
  }

  return results;
}
