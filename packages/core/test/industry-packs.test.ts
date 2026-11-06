import { describe, expect, it } from "vitest";
import { INDUSTRY_PACKS, PACK_VERSION, getPack, listPacks } from "../src/industries/packs";
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
});
