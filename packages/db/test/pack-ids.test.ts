import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Drift guard for migration 0021: the `organizations_industry_check` CHECK list
 * must exactly match the pack ids in `packages/core/src/industries/overlays.ts`.
 * Adding a pack without updating the migration (or vice versa) fails here.
 * Pure file comparison — no database needed.
 */
function sqlIds(): string[] {
  const sql = readFileSync(path.resolve(import.meta.dirname, "../migrations/0021_industry_packs_and_speed.sql"), "utf8");
  const match = sql.match(/industry IS NULL OR industry IN \(([^)]+)\)/s);
  if (!match) throw new Error("industry CHECK not found in 0021");
  return [...match[1]!.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]!).sort();
}

function codeIds(): string[] {
  const overlays = readFileSync(
    path.resolve(import.meta.dirname, "../../core/src/industries/overlays.ts"),
    "utf8",
  );
  return [...new Set([...overlays.matchAll(/\{ id: "([a-z_0-9]+)", base:/g)].map((m) => m[1]!))].sort();
}

describe("industry pack ids", () => {
  it("0021 CHECK constraint matches overlays.ts exactly", () => {
    expect(sqlIds()).toEqual(codeIds());
  });
});
