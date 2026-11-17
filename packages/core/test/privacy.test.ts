import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERASURE_BLOCKERS, TABLE_POLICY } from "../src/privacy/registry";
import { erasureOrder, exportTenant, planErasure, tenantTables, unclassifiedTables, type TableReader } from "../src/privacy/plan";

describe("data-subject rights", () => {
  it("every tenant-scoped table in the real schema is classified (drift guard)", () => {
    expect(tenantTables().length).toBeGreaterThan(40);
    expect(unclassifiedTables()).toEqual([]);
  });

  it("no policy names a table that no longer exists", () => {
    const real = new Set(tenantTables().map((t) => t.name));
    expect(Object.keys(TABLE_POLICY).filter((n) => !real.has(n))).toEqual([]);
  });

  it("erasure order covers exactly the deletable tables, once each", () => {
    const deletable = tenantTables().map((t) => t.name).filter((n) => TABLE_POLICY[n]?.erase === "delete").sort();
    expect([...erasureOrder()].sort()).toEqual(deletable);
    expect(new Set(erasureOrder()).size).toBe(erasureOrder().length);
    expect(erasureOrder()).not.toContain("suppression_list");
    expect(erasureOrder()).not.toContain("audit_events");
  });

  it("erasure order respects every foreign key declared in the migration SQL", () => {
    const dir = join(__dirname, "../../db/migrations");
    const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(join(dir, f), "utf8")).join("\n").replace(/--[^\n]*/g, "");
    const edges = new Map<string, Set<string>>();
    const add = (c: string, p: string) => { if (!edges.has(c)) edges.set(c, new Set()); edges.get(c)!.add(p); };
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\);/g)) for (const r of m[2]!.matchAll(/REFERENCES\s+(\w+)/g)) add(m[1]!, r[1]!);
    for (const m of sql.matchAll(/ALTER TABLE (\w+)\s+ADD[^;]*?REFERENCES\s+(\w+)/g)) add(m[1]!, m[2]!);
    expect(edges.size).toBeGreaterThan(30); // the parser found the schema
    edges.get("agents")?.delete("agent_versions"); // cycle broken by ERASURE_PRE_STEPS
    const order = erasureOrder();
    const bad: string[] = [];
    for (const child of order) for (const parent of edges.get(child) ?? []) {
      if (parent !== child && order.includes(parent) && order.indexOf(child) > order.indexOf(parent)) bad.push(`${child} must be deleted before ${parent}`);
    }
    expect(bad).toEqual([]);
    // Retained tables that point at a deletable table are blockers and must be disclosed.
    const blockers = [...edges].flatMap(([c, ps]) => TABLE_POLICY[c]?.erase === "retain" ? [...ps].filter((p) => order.includes(p)).map((p) => `${c}->${p}`) : []);
    expect(blockers).toEqual(["audit_events->approval_requests"]);
    expect(ERASURE_BLOCKERS.join(" ")).toMatch(/audit_events[\s\S]*approval_requests/);
  });

  it("the erasure plan is plan-only, tier 4, exports first, and lists what it keeps", () => {
    const p = planErasure("11111111-1111-1111-1111-111111111111", "owner-a");
    expect(p.status).toBe("plan_only_not_executed");
    expect(p.approvalTier).toBe(4);
    expect(p.exportFirst).toBe(true);
    expect(p.retained.map((r) => r.table)).toEqual(expect.arrayContaining(["suppression_list", "billing_ledger", "audit_events"]));
    expect(p.retained.every((r) => r.legalReview === "pending")).toBe(true);
    expect(p.notes.join(" ")).toMatch(/Nothing has been deleted/);
    expect(p.organizationRow).toBe("anonymize_do_not_delete");
    expect(p.blockers.length).toBeGreaterThanOrEqual(3);
    expect(p.preSteps[0]).toMatch(/current_version_id/);
  });

  it("export strips credentials, covers every tenant table, and reads only the asked tenant", async () => {
    const asked: string[] = [];
    const reader: TableReader = {
      async read(table, tenantId) {
        asked.push(`${table}:${tenantId}`);
        if (table === "integration_connections") return [{ id: "1", provider: "gmail", secret_ciphertext: "XXX", secret_ref: "ref", secretCiphertext: "YYY" }];
        if (table === "payment_destinations") return [{ id: "2", label: "Ops", ciphertext: "ACCT" }];
        return [];
      },
    };
    const b = await exportTenant(reader, "T1", new Date("2026-11-17T00:00:00Z"));
    expect(Object.keys(b.tables).sort()).toEqual(tenantTables().map((t) => t.name));
    expect(asked.every((a) => a.endsWith(":T1"))).toBe(true);
    const json = JSON.stringify(b);
    for (const secret of ["XXX", "YYY", "ACCT", "\"ref\""]) expect(json).not.toContain(secret);
    expect(b.tables.integration_connections![0]).toEqual({ id: "1", provider: "gmail" });
    expect(b.omittedColumns.payment_destinations).toEqual(["ciphertext"]);
  });
});
