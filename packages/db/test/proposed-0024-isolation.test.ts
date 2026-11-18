import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { ownerQuery } from "./helpers";

/**
 * Applies proposed 0024 inside one transaction on the test database, checks
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

describe("proposed 0024 managed_numbers (rolled back, never applied)", () => {
  const sqlUp = statements("0024_managed_numbers.sql");
  const sqlDown = statements("0024_managed_numbers.down.sql");

  it("isolates numbers by tenant, enforces one-holder-per-phone, then disappears on rollback", async () => {
    const before = await ownerQuery<{ name: string }>("SELECT name FROM schema_migrations WHERE name LIKE '0024%'");
    expect(before).toEqual([]);
    const client = new pg.Client({ connectionString: adminUrl() });
    await client.connect();
    const a = randomUUID();
    const b = randomUUID();
    try {
      await client.query("BEGIN");
      for (const statement of sqlUp) await client.query(statement);

      const forced = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'managed_numbers'`,
      );
      expect(forced.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [a]);
      await client.query("INSERT INTO organizations (id, name) VALUES ($1, 'Num A')", [a]);
      await client.query("INSERT INTO managed_numbers (tenant_id, phone, status) VALUES ($1, '+13145550100', 'active')", [a]);

      // One active number per workspace.
      await expectPg(client, "INSERT INTO managed_numbers (tenant_id, phone, status) VALUES ($1, '+13145550199', 'active')", [a], /managed_numbers_tenant_active/);

      // Tenant B cannot see A's number…
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [b]);
      await client.query("INSERT INTO organizations (id, name) VALUES ($1, 'Num B')", [b]);
      const hidden = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM managed_numbers");
      expect(hidden.rows[0]!.n).toBe(0);

      // …and cannot hold the same phone (the unique index is global, not per-tenant;
      // the row insert violates it even though B cannot see A's row).
      await expectPg(client, "INSERT INTO managed_numbers (tenant_id, phone, status) VALUES ($1, '+13145550100', 'reserving')", [b], /managed_numbers_phone_held/);

      // B CAN hold the same phone once A's row is released (switch to A, release, back to B).
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [a]);
      await client.query("UPDATE managed_numbers SET status = 'released' WHERE tenant_id = $1", [a]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [b]);
      await client.query("INSERT INTO managed_numbers (tenant_id, phone, status) VALUES ($1, '+13145550100', 'reserving')", [b]);

      // A2P defaults to not_started; bogus statuses are refused.
      const def = await client.query<{ a2p_status: string }>("SELECT a2p_status FROM managed_numbers WHERE tenant_id = $1", [b]);
      expect(def.rows[0]!.a2p_status).toBe("not_started");
      await expectPg(client, "UPDATE managed_numbers SET a2p_status = 'banana' WHERE tenant_id = $1", [b], /a2p_status/);

      // app_user has no DELETE: released records are kept.
      await expectPg(client, "DELETE FROM managed_numbers WHERE tenant_id = $1", [b], /permission denied/);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }

    // Rollback worked: no trace in schema_migrations.
    const after = await ownerQuery<{ name: string }>("SELECT name FROM schema_migrations WHERE name LIKE '0024%'");
    expect(after).toEqual([]);
  });

  it("has a parseable down migration that drops the table", () => {
    expect(sqlDown.join(" ")).toMatch(/DROP TABLE IF EXISTS managed_numbers/i);
  });
});
