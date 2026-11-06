import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "src", "app");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

describe("type scale", () => {
  it("uses only named sizes: no one-off text-[…] values", () => {
    const offenders = files(root).filter((f) => /\btext-\[\d/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("every page title uses the display size", () => {
    const bad = files(root).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/<h1 className="([^"]*)"/g)].map((m) => m[1]!).filter((c) => !c.includes("text-display")).map((c) => `${f}: ${c}`));
    expect(bad).toEqual([]);
  });
  it("defines the scale tokens", () => {
    const css = readFileSync(join(root, "globals.css"), "utf8");
    for (const t of ["--text-small", "--text-message", "--text-display"]) expect(css).toContain(t);
  });
});
