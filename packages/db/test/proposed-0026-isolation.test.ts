import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { ownerQuery } from "./helpers";

/**
 * Applies proposed 0026 inside one transaction on the test database, checks
 * tenant isolation as app_user, then rolls the transaction back. Nothing is
 * committed and schema_migrations is not touched.
 */
function statements(file: string): string[] {
  const raw = readFileSync(path.resolve(import.meta.dirname, "../proposed", file), "utf8");
  return raw
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/--[^\n]*/g, "").trim())
    .filter(Boolean);
}

function adminUrl(): string {
  if (process.env.DATABASE_URL_ADMIN) return process.env.DATABASE_URL_ADMIN;
  const app = new URL(process.env.DATABASE_URL ?? "postgres://app_user:app_dev_pw@127.0.0.1:5432/wos_test");
  app.username = "postgres";
  app.password = "";
  return app.toString();
}

/** A failed statement aborts the transaction, so expectations-on-failure need a savepoint. */
async function expectPg(client: pg.Client, sqlText: string, params: unknown[], pattern: RegExp) {
  await client.query("SAVEPOINT expect_fail");
  const err = await client.query(sqlText, params).then(
    () => undefined,
    (e: unknown) => e as { message: string },
  );
  await client.query("ROLLBACK TO SAVEPOINT expect_fail");
  expect(err, "expected the statement to fail").toBeDefined();
  expect(err?.message).toMatch(pattern);
}

describe("proposed 0026 jobs (rolled back, never applied)", () => {
  const sqlUp = statements("0026_jobs.sql");
  const sqlDown = statements("0026_jobs.down.sql");

  it("isolates jobs by tenant, constrains status/pack ids, then disappears on rollback", async () => {
    const before = await ownerQuery<{ name: string }>("SELECT name FROM schema_migrations WHERE name LIKE '0026%'");
    expect(before).toEqual([]);
    const client = new pg.Client({ connectionString: adminUrl() });
    await client.connect();
    const a = randomUUID();
    const b = randomUUID();
    try {
      await client.query("BEGIN");
      for (const statement of sqlUp) await client.query(statement);

      const forced = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('jobs', 'jobs_config') ORDER BY relname`,
      );
      expect(forced.rows).toEqual([
        { relname: "jobs", relrowsecurity: true, relforcerowsecurity: true },
        { relname: "jobs_config", relrowsecurity: true, relforcerowsecurity: true },
      ]);

      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [a]);
      await client.query("INSERT INTO organizations (id, name) VALUES ($1, 'Jobs A')", [a]);
      await client.query(
        "INSERT INTO jobs (tenant_id, pack_id, customer_name, answers, created_by) VALUES ($1, 'moving', 'Ada', '{\"move_type\":\"local\"}', 'user-a')",
        [a],
      );

      // Defaults: inquiry status, intrastate, empty crew.
      const def = await client.query<{ status: string; jurisdiction: string; crew: unknown[] }>(
        "SELECT status, jurisdiction, crew FROM jobs WHERE tenant_id = $1",
        [a],
      );
      expect(def.rows[0]).toMatchObject({ status: "inquiry", jurisdiction: "intrastate", crew: [] });

      // Bogus statuses and pack ids are refused by CHECK constraints.
      await expectPg(client, "UPDATE jobs SET status = 'flying' WHERE tenant_id = $1", [a], /jobs_status_check/);
      await expectPg(client, "INSERT INTO jobs (tenant_id, pack_id, customer_name, created_by) VALUES ($1, 'Moving!!', 'Bo', 'user-a')", [a], /jobs_pack_id_check/);

      // Config row for A.
      await client.query("INSERT INTO jobs_config (tenant_id, owner_configured_prices) VALUES ($1, true)", [a]);

      // Tenant B cannot see A's job or config.
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [b]);
      await client.query("INSERT INTO organizations (id, name) VALUES ($1, 'Jobs B')", [b]);
      const hidden = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs");
      expect(hidden.rows[0]!.n).toBe(0);
      const hiddenCfg = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs_config");
      expect(hiddenCfg.rows[0]!.n).toBe(0);

      // B can hold its own job with the same customer name (no cross-tenant uniqueness).
      await client.query(
        "INSERT INTO jobs (tenant_id, pack_id, customer_name, created_by) VALUES ($1, 'hvac', 'Ada', 'user-b')",
        [b],
      );

      // app_user has no DELETE: a job is a financial record.
      await expectPg(client, "DELETE FROM jobs WHERE tenant_id = $1", [b], /permission denied/);
      await expectPg(client, "DELETE FROM jobs_config WHERE tenant_id = $1", [b], /permission denied/);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }

    // Rollback worked: no trace in schema_migrations.
    const after = await ownerQuery<{ name: string }>("SELECT name FROM schema_migrations WHERE name LIKE '0026%'");
    expect(after).toEqual([]);
  });

  it("has a parseable down migration that drops both tables", () => {
    expect(sqlDown.join(" ")).toMatch(/DROP TABLE IF EXISTS jobs_config/i);
    expect(sqlDown.join(" ")).toMatch(/DROP TABLE IF EXISTS jobs/i);
  });
});
