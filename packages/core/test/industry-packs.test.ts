import { describe, expect, it } from "vitest";
import { INDUSTRY_PACKS, PACK_GROUPS, PACK_VERSION, closestPack, getPack, listPacks, searchPacks } from "../src/industries/packs";
import { REQUIRED_PACKS, packSchema } from "../src/industries/schema";

describe("industry packs", () => {
  it("is versioned data and every pack matches the schema", () => {
    expect(PACK_VERSION).toBe(1);
    expect(new Set(INDUSTRY_PACKS.map((p) => p.id)).size).toBe(INDUSTRY_PACKS.length);
    for (const pack of listPacks()) {
      const parsed = packSchema.safeParse(pack);
      expect(parsed.success, parsed.success ? pack.id : JSON.stringify(parsed.error.issues)).toBe(true);
      expect(pack.version).toBe(PACK_VERSION);
      expect(pack.routines.every((r) => r.tier <= 1)).toBe(true);
      expect(pack.services.every((s) => s.priceIsExample)).toBe(true);
      expect(pack.templates.some((t) => t.purpose === "first_response")).toBe(true);
      expect(pack.integrations.map((i) => i.kind).sort().join(",")).toBe("accounting,calendar,crm");
      expect(pack.metrics.length).toBeGreaterThanOrEqual(2);
      expect(pack.templates.filter((t) => t.channel === "sms").every((t) => /STOP/.test(t.body))).toBe(true);
    }
  });

  it("covers the trades we sell, with the right kind of work", () => {
    for (const id of REQUIRED_PACKS) expect(getPack(id).id).toBe(id);
    expect(getPack("roofing").signals).toContain("weather");
    expect(getPack("hvac").signals).toContain("seasonal");
    expect(getPack("auto_repair").pipeline.join(" ")).toMatch(/Diagnosed/);
    for (const id of ["nail_salon", "hair_salon", "esthetics"] as const) {
      const pack = getPack(id);
      expect(pack.flow).toBe("appointment");
      expect(pack.services.every((s) => (s.durationMinutes ?? 0) > 0)).toBe(true);
      expect(pack.templates.some((t) => t.purpose === "rebook" || t.purpose === "review")).toBe(true);
      expect(pack.routines.some((r) => r.tier <= 1 && /rebook|review|no-show/i.test(r.title + r.does))).toBe(true);
    }
    expect(getPack("barber").label).toMatch(/barber/i);
    expect(getPack("barber").pipeline.join(" ")).toMatch(/Waitlist/);
    expect(getPack("esthetics").summary).toMatch(/not a medical/i);
  });

  it("builds the priority trades from five shared bases", () => {
    const bases = {
      plumbing: "urgent_trade",
      hvac: "urgent_trade",
      roofing: "urgent_trade",
      electrical: "urgent_trade",
      house_cleaning: "recurring_service",
      landscaping: "recurring_service",
      pest_control: "recurring_service",
      auto_repair: "auto",
      tire_shop: "auto",
      auto_glass: "auto",
      auto_detail: "auto",
      hair_salon: "booking_beauty",
      barber: "booking_beauty",
      nail_salon: "booking_beauty",
      lash_brow: "booking_beauty",
      med_spa: "booking_beauty",
      dental: "booking_beauty",
      moving: "quote_velocity",
      junk_removal: "quote_velocity",
    } as const;
    for (const [id, base] of Object.entries(bases)) {
      const pack = getPack(id);
      expect(pack.base, id).toBe(base);
      expect(pack.services, id).toHaveLength(5);
      expect(pack.templates, id).toHaveLength(3);
      expect(pack.routines, id).toHaveLength(3);
      expect(pack.routines.every((r) => r.tier <= 1), id).toBe(true);
      expect(pack.metrics[0]?.id, id).toBe("morning");
      expect(pack.integrations.map((i) => i.kind).sort().join(","), id).toBe("accounting,calendar,crm");
    }
    for (const id of ["nail_salon", "lash_brow"] as const) {
      const days = getPack(id).rebookEveryDays?.find((r) => r.serviceId === "fill" || r.serviceId === "lash_fill")?.days ?? 0;
      expect(days).toBeGreaterThanOrEqual(14);
      expect(days).toBeLessThanOrEqual(21);
      expect(getPack(id).templates.some((t) => /never charged automatically/i.test(t.body))).toBe(true);
    }
    expect(getPack("med_spa").summary).toMatch(/no health records/i);
    expect(getPack("med_spa").templates.some((t) => /never charged automatically/i.test(t.body))).toBe(true);
    expect(getPack("dental").routines.some((r) => /recall/i.test(r.title))).toBe(true);
    expect(JSON.stringify(getPack("dental"))).not.toMatch(/diagnos|prescription|patient chart|session note/i);
    expect(getPack("junk_removal").pipeline.join(" ")).toMatch(/Photo/);
    expect(getPack("general").base).toBe("general");
  });

  it("covers the broader trades and refuses medical-record language", () => {
    for (const group of PACK_GROUPS) expect(listPacks().some((p) => p.group === group)).toBe(true);
    const sensitive = listPacks().filter((p) => p.group === "Health & wellness" || p.group === "Education & childcare" || p.group === "Pets");
    expect(sensitive.length).toBeGreaterThan(0);
    for (const pack of sensitive) {
      const text = JSON.stringify(pack);
      expect(text).not.toMatch(/diagnos|prescription|medical record|patient chart|\bPHI\b|insurance claim/i);
    }
    for (const pack of listPacks().filter((p) => p.group === "Health & wellness" || p.id === "childcare")) {
      expect(pack.summary).toMatch(/no health records|not a clinic|No health records/i);
    }
    expect(closestPack("mobile dog wash").pack.id).toBe("dog_grooming");
    expect(closestPack("yoga").pack.id).toBe("yoga_studio");
    expect(closestPack("asdfqqq-not-a-trade").pack.id).toBe("general");
    expect(closestPack("asdfqqq-not-a-trade").matched).toBe(false);
    expect(searchPacks("cafe").some((p) => p.id === "cafe")).toBe(true);
    expect(getPack("startup_saas").templates.every((t) => t.channel === "sms" || t.channel === "email")).toBe(true);
  });
});
