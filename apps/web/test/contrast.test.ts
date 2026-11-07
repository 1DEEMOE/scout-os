import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Reads the real design tokens from globals.css, so changing a colour can't
// silently drop text below WCAG 2.2 AA (4.5:1) in either theme.
const css = readFileSync(path.resolve(import.meta.dirname, "../src/app/globals.css"), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));
}

function luminance(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const themes = { light: block("@theme"), dark: block(':root[data-theme="dark"]') };
const TEXT = ["ink", "muted", "accent", "danger", "warn", "caution"];
const BACKGROUNDS = ["paper", "surface", "soft"];

describe("design token contrast (WCAG 2.2 AA)", () => {
  for (const [name, t] of Object.entries(themes)) {
    for (const fg of TEXT) {
      for (const bg of BACKGROUNDS) {
        it(`${name}: ${fg} on ${bg} >= 4.5:1`, () => {
          expect(t[fg], `${name} ${fg}`).toBeTruthy();
          expect(ratio(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    it(`${name}: body ink on paper >= 7:1`, () => {
      expect(ratio(t.ink!, t.paper!)).toBeGreaterThanOrEqual(7);
    });
    it(`${name}: chrome ink on the bar >= 7:1`, () => {
      expect(ratio(t["chrome-ink"]!, t.chrome!)).toBeGreaterThanOrEqual(7);
    });
    it(`${name}: chrome secondary text on the bar >= 4.5:1`, () => {
      expect(ratio(t["chrome-muted"]!, t.chrome!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t["chrome-accent"]!, t.chrome!)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: text on the accent button >= 4.5:1`, () => {
      expect(ratio(t["on-accent"]!, t.accent!)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: accent text on its soft tint >= 4.5:1`, () => {
      expect(ratio(t.accent!, t["accent-soft"]!)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: gradient stops keep primary-button text`, () => {
      expect(ratio(t["on-accent"]!, t["accent-from"]!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t["on-accent"]!, t["accent-to"]!)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("entrance motion never fades text (contrast stays AA on the first frame)", () => {
    for (const name of ["rise-in", "pop-in"]) {
      const start = css.indexOf(`@keyframes ${name}`);
      expect(start, name).toBeGreaterThanOrEqual(0);
      let depth = 0;
      let end = -1;
      for (let i = css.indexOf("{", start); i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}" && --depth === 0) {
          end = i;
          break;
        }
      }
      expect(css.slice(start, end + 1), name).not.toMatch(/opacity/);
    }
  });

  it("industry accents stay at least AA on every surface", () => {
    const lightPaper = themes.light.paper!;
    const lightSurface = themes.light.surface!;
    const lightSoft = themes.light.soft!;
    const darkPaper = themes.dark.paper!;
    const darkSurface = themes.dark.surface!;
    const darkSoft = themes.dark.soft!;
    for (const match of css.matchAll(/html\[data-accent="([a-z]+)"\] \{([^}]+)\}/g)) {
      const colors = Object.fromEntries([...match[2]!.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));
      for (const bg of [lightPaper, lightSurface, lightSoft]) expect(ratio(colors.accent!, bg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(colors["on-accent"]!, colors.accent!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(colors.accent!, colors["accent-soft"]!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(colors["on-accent"]!, colors["accent-from"]!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(colors["on-accent"]!, colors["accent-to"]!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(themes.light.ink!, colors["accent-soft"]!)).toBeGreaterThanOrEqual(4.5);
    }
    for (const match of css.matchAll(/:root\[data-theme="dark"\]\[data-accent="([a-z]+)"\] \{([^}]+)\}/g)) {
      const colors = Object.fromEntries([...match[2]!.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));
      for (const bg of [darkPaper, darkSurface, darkSoft]) expect(ratio(colors.accent!, bg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(colors["on-accent"]!, colors.accent!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(colors.accent!, colors["accent-soft"]!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(colors["on-accent"]!, colors["accent-from"]!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(colors["on-accent"]!, colors["accent-to"]!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(themes.dark.ink!, colors["accent-soft"]!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the gradient is only the primary fill, not every accent surface", () => {
    expect(css).toMatch(/\.accent-fill\s*\{[^}]*linear-gradient/);
    expect(css).not.toMatch(/\.bg-accent\s*\{[^}]*linear-gradient/);
  });

  it("the system-dark block matches the explicit dark theme", () => {
    const sys = css.slice(css.indexOf(':root:not([data-theme="light"])'));
    const sysVals = Object.fromEntries([...sys.slice(0, sys.indexOf("}")).matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));
    expect(sysVals).toEqual(themes.dark);
  });
});
