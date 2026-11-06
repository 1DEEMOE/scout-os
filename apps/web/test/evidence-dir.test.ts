import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evidenceDir } from "../e2e/evidence-dir";

const created: string[] = [];

afterEach(() => {
  delete process.env.WOS_EVIDENCE_DIR;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("evidenceDir", () => {
  it("defaults to a repo-relative directory under test-results", () => {
    delete process.env.WOS_EVIDENCE_DIR;
    const dir = evidenceDir("onboarding");
    expect(dir).toContain(path.join("apps", "web", "test-results", "evidence", "onboarding"));
    expect(dir.startsWith("/workspace/scout-os")).toBe(false);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it("honours WOS_EVIDENCE_DIR, including a relative root", () => {
    const abs = mkdtempSync(path.join(tmpdir(), "wos-evidence-"));
    created.push(abs);
    process.env.WOS_EVIDENCE_DIR = abs;
    expect(evidenceDir("onboarding")).toBe(path.join(abs, "onboarding"));

    const rel = path.join("apps", "web", "test-results", "evidence-rel-probe");
    created.push(path.resolve(path.join(import.meta.dirname, "../../.."), rel));
    process.env.WOS_EVIDENCE_DIR = rel;
    const dir = evidenceDir("sidebar");
    expect(dir).toBe(path.resolve(path.join(import.meta.dirname, "../../.."), rel, "sidebar"));
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});
