import { describe, expect, it } from "vitest";
import { buildEstimate, disclosuresFor, elitePackSchema, getElitePack, hasElitePack, renderEstimateText, validateIntake } from "../src/industries/elite";
import { getPack } from "../src/industries/packs";

const moving = getElitePack("moving")!;
const local = { move_type: "local", home_size: "2br", origin_address: "1 A St", dest_address: "9 B Ave", move_date: "2026-12-12", crew_size: 3, est_hours: 5, stair_flights: 2, long_carry: true, packing: "partial", boxes: 20 };
const long = { move_type: "long", home_size: "3br", origin_address: "1 A St", dest_address: "TX", move_date: "2026-12-20", crew_size: 4, cubic_feet: 800, valuation: "full_value", declared_value: 40000 };
const biz = { usdot_number: "1234567", mc_number: "MC-1", business_address: "1 Main St" };

describe("elite moving pack", () => {
  it("attaches to the existing overlay and parses", () => {
    expect(hasElitePack("moving")).toBe(true);
    expect(getPack("moving").id).toBe(moving.id);
    expect(elitePackSchema.safeParse(moving).success).toBe(true);
    expect(hasElitePack("plumbing")).toBe(false);
  });

  it("rejects bad packs: unknown placeholder, sms without STOP, tier-1 cadence, dangling pricing field", () => {
    /** Clone the pack, set one value at a dotted path, report whether it still parses. */
    const bad = (path: string, value: unknown): boolean => {
      const root: Record<string, unknown> = JSON.parse(JSON.stringify(moving));
      const keys = path.split(".");
      let cur: Record<string, unknown> = root;
      for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
      cur[keys[keys.length - 1]!] = value;
      return elitePackSchema.safeParse(root).success;
    };
    expect(bad("cadences.0.body", "Hi {{ssn}} checking in on your estimate")).toBe(false);
    expect(bad("cadences.1.body", "Reminder: your move is tomorrow, see you then.")).toBe(false);
    expect(bad("cadences.0.approvalTier", 1)).toBe(false);
    expect(bad("pricing.common.0.field", "nope")).toBe(false);
    expect(bad("scheduling.dispatchRequiresApproval", false)).toBe(false);
    expect(bad("pricing.bindingAllowedByDefault", true)).toBe(false);
    expect(bad("compliance.approvalFloors.send_estimate", 1)).toBe(false);
    expect(bad("pricing.depositBps", 2000)).toBe(true); // control: a valid edit still parses
  });

  it("intake: required, conditional, and forbidden fields", () => {
    expect(validateIntake(moving, local).ok).toBe(true);
    expect(validateIntake(moving, { move_type: "long" }).missing).toContain("cubic_feet");
    expect(validateIntake(moving, local).visible.some((f) => f.id === "cubic_feet")).toBe(false);
    expect(validateIntake(moving, { ...local, ssn: "123" }).ok).toBe(false);
    expect(validateIntake(moving, { ...local, crew_size: 99 }).errors.join()).toMatch(/out of range/);
  });

  it("local estimate math is exact", () => {
    const e = buildEstimate(moving, local, { jurisdiction: "intrastate", businessProfile: biz });
    // 5h × $200/h (crew 3) + $100 trip = 110000; stairs 2×7500=15000; long carry 15000; materials 20×400=8000
    expect(e.lines.map((l) => [l.id, l.cents])).toEqual([["labor", 110000], ["stairs", 15000], ["long_carry", 15000], ["materials", 8000]]);
    expect(e.totalCents).toBe(148000);
    expect(e.depositCents).toBe(29600);
  });

  it("local minimum hours apply", () => {
    const e = buildEstimate(moving, { ...local, est_hours: 1, stair_flights: 0, long_carry: false, packing: "none" }, { jurisdiction: "intrastate", businessProfile: biz });
    expect(e.lines[0]!.cents).toBe(3 * 20000 + 10000);
  });

  it("long-distance by volume, with full value protection as percent of declared value", () => {
    const e = buildEstimate(moving, long, { jurisdiction: "interstate", businessProfile: biz });
    expect(e.lines.find((l) => l.id === "volume")!.cents).toBe(400000);
    expect(e.lines.find((l) => l.id === "full_value")!.cents).toBe(40000);
    expect(e.totalCents).toBe(400000 + 50000 + 40000);
    expect(e.kind).toBe("non_binding");
    expect(e.deliveryCollectCapCents).toBe(Math.round(e.totalCents * 1.1));
  });

  it("never sendable on example prices, and says so", () => {
    const e = buildEstimate(moving, local, { jurisdiction: "intrastate", businessProfile: biz });
    expect(e.status).toBe("draft_needs_approval");
    expect(e.priceBasis).toBe("example");
    expect(e.blockedReasons.join()).toMatch(/examples/);
    expect(renderEstimateText(moving, e, { business: "Acme", customer: "Sam", jurisdiction: "intrastate" })).toMatch(/SAMPLE PRICES/);
  });

  it("binding needs owner switch AND confirmed prices; otherwise downgrades; binding is tier 3", () => {
    const base = { jurisdiction: "intrastate" as const, businessProfile: biz, requestBinding: true };
    expect(buildEstimate(moving, local, base).kind).toBe("non_binding");
    expect(buildEstimate(moving, local, { ...base, ownerAllowsBinding: true }).kind).toBe("non_binding");
    expect(buildEstimate(moving, local, { ...base, ownerConfiguredPrices: true }).kind).toBe("non_binding");
    const ok = buildEstimate(moving, local, { ...base, ownerAllowsBinding: true, ownerConfiguredPrices: true });
    expect(ok.kind).toBe("binding");
    expect(ok.approvalTier).toBe(3);
    expect(ok.blockedReasons).toEqual([]);
    expect(buildEstimate(moving, local, { ...base, ownerConfiguredPrices: true }).approvalTier).toBe(2);
  });

  it("owner overrides replace example numbers", () => {
    const e = buildEstimate(moving, local, { jurisdiction: "intrastate", businessProfile: biz, ownerConfiguredPrices: true, overrides: { stairs: { unitCents: 10000 } } });
    expect(e.lines.find((l) => l.id === "stairs")!.cents).toBe(20000);
  });

  it("interstate blocks without USDOT/MC; intrastate does not require them", () => {
    const noDot = buildEstimate(moving, long, { jurisdiction: "interstate", ownerConfiguredPrices: true, businessProfile: { business_address: "x" } });
    expect(noDot.blockedReasons.join()).toMatch(/USDOT number/);
    expect(buildEstimate(moving, local, { jurisdiction: "intrastate", ownerConfiguredPrices: true, businessProfile: { business_address: "x" } }).blockedReasons).toEqual([]);
  });

  it("injects required disclosures per jurisdiction, all marked pending legal review", () => {
    const inter = disclosuresFor(moving, "estimate", "interstate").map((d) => d.id);
    const intra = disclosuresFor(moving, "estimate", "intrastate").map((d) => d.id);
    expect(inter).toEqual(expect.arrayContaining(["interstate_booklet", "interstate_cap", "valuation", "nonbinding_note"]));
    expect(intra).not.toContain("interstate_booklet");
    expect(moving.compliance.disclosures.every((d) => d.legalReview === "pending")).toBe(true);
    const e = buildEstimate(moving, long, { jurisdiction: "interstate", businessProfile: biz });
    const text = renderEstimateText(moving, e, { business: "Acme Movers", customer: "Sam", jurisdiction: "interstate", usdot: "1234567" });
    expect(text).toMatch(/USDOT 1234567/);
    expect(text).toMatch(/Required notices/);
    expect(text).toMatch(/never charged automatically/);
  });

  it("every cadence is approval-gated (tier >= 2), consent-checked, and SMS carries STOP", () => {
    for (const c of moving.cadences) {
      expect(c.approvalTier).toBeGreaterThanOrEqual(2);
      expect(c.consentCheckedAtSend).toBe(true);
      if (c.channel === "sms") expect(c.body).toMatch(/STOP/);
    }
  });
});
