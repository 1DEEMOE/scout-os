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
    expect(getPack("hair_salon").label).toMatch(/barber/i);
    expect(getPack("esthetics").summary).toMatch(/not a medical/i);
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
