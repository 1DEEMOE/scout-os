import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEVELS } from "../src/app/ui";

const root = join(__dirname, "..", "src", "app");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });
/** Drop comments so only what people can see is checked. */
const visible = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("approval levels wording", () => {
  it("defines five plain-words levels, 0 to 4", () => {
    expect(LEVELS.map((l) => l.n)).toEqual([0, 1, 2, 3, 4]);
    expect(LEVELS[4]!.rule).toMatch(/second owner/);
  });
  it("no screen says 'risk level' or 'tier N' to people: everything uses the level names", () => {
    const bad = files(root).flatMap((f) => {
      const text = visible(readFileSync(f, "utf8"));
      return [...text.matchAll(/Risk level|\btier\s+[0-4]\b/gi)].map((m) => `${f.replace(root, "")}: ${m[0]}`);
    });
    expect(bad).toEqual([]);
  });
});
