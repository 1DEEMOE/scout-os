import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { listPacks } from "../../core/src/industries/packs";
import { closePool } from "../src/index";
import { adminQuery, ownerQuery } from "./helpers";

/**
 * Applies proposed 0021 inside one transaction on the test database, checks
 * tenant isolation as app_user, then rolls the transaction back. Nothing is
 * committed and schema_migrations is not touched.
 */
const TABLES = ["service_menu_items", "bookable_resources", "appointments", "response_templates"] as const;

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

describe("proposed 0021 (rolled back, never applied)", () => {
  const sqlUp = statements("0021_industry_packs_and_speed.sql");
  const sqlDown = statements("0021_industry_packs_and_speed.down.sql");

  it("names every current pack id in the industry check", () => {
    const text = readFileSync(path.resolve(import.meta.dirname, "../proposed/0021_industry_packs_and_speed.sql"), "utf8");
    for (const pack of listPacks()) expect(text).toContain(`'${pack.id}'`);
  });

  it("isolates the new tables by tenant, then disappears on rollback", async () => {
    const before = await ownerQuery<{ name: string }>("SELECT name FROM schema_migrations WHERE name LIKE '0021%'");
    expect(before).toEqual([]);
    const client = new pg.Client({ connectionString: adminUrl() });
    await client.connect();
    const a = randomUUID();
    const b = randomUUID();
    try {
      await client.query("BEGIN");
      for (const statement of sqlUp) await client.query(statement);

      const forced = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE relname = ANY($1::text[])`,
        [TABLES],
      );
      expect(forced.rows).toHaveLength(TABLES.length);
      for (const row of forced.rows) {
        expect(row.relrowsecurity, row.relname).toBe(true);
        expect(row.relforcerowsecurity, row.relname).toBe(true);
      }

      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [a]);
      await client.query("INSERT INTO organizations (id, name, industry) VALUES ($1, 'Pack A', 'nail_salon')", [a]);
      const menu = await client.query<{ id: string }>(
        `INSERT INTO service_menu_items (tenant_id, pack_service_id, label, price_cents, price_is_example)
         VALUES ($1, 'fill', 'Fill', 5500, true) RETURNING id`,
        [a],
      );
      const chair = await client.query<{ id: string }>(
        `INSERT INTO bookable_resources (tenant_id, name, kind) VALUES ($1, 'Chair 1', 'chair') RETURNING id`,
        [a],
      );
      await client.query(
        `INSERT INTO appointments (tenant_id, service_id, resource_id, starts_at, ends_at, status)
         VALUES ($1, $2, $3, now(), now() + interval '1 hour', 'booked')`,
        [a, menu.rows[0]!.id, chair.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO response_templates (tenant_id, purpose, channel, name, body, status)
         VALUES ($1, 'first_response', 'sms', 'Hello', 'Hi {{name}}', 'ready_to_approve')`,
        [a],
      );

      await client.query("SELECT set_config('app.tenant_id', $1, true)", [b]);
      await client.query("INSERT INTO organizations (id, name, industry) VALUES ($1, 'Pack B', 'hvac')", [b]);
      const hidden = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM service_menu_items");
      expect(hidden.rows[0]!.n).toBe(0);
      const hiddenVisits = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM appointments");
      expect(hiddenVisits.rows[0]!.n).toBe(0);
      await expectPg(
        client,
        `INSERT INTO service_menu_items (tenant_id, pack_service_id, label) VALUES ($1, 'x', 'Stolen')`,
        [a],
        /row-level security/,
      );
      await expectPg(
        client,
        `INSERT INTO appointments (tenant_id, service_id, starts_at, ends_at, status)
         VALUES ($1, $2, now(), now() + interval '30 minutes', 'booked')`,
        [b, menu.rows[0]!.id],
        /foreign key|row-level security/,
      );
      const bogus = randomUUID();
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [bogus]);
      await expectPg(
        client,
        "INSERT INTO organizations (id, name, industry) VALUES ($1, 'Nope', 'not_a_pack')",
        [bogus],
        /check constraint/,
      );

      await client.query("RESET ROLE");
      await client.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [[a, b]]);
      for (const statement of sqlDown) await client.query(statement);
      const gone = await client.query<{ reg: string | null }>("SELECT to_regclass('public.service_menu_items') AS reg");
      expect(gone.rows[0]!.reg).toBeNull();
      await client.query("ROLLBACK");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      await client.end();
    }

    const after = await ownerQuery<{ name: string }>("SELECT name FROM schema_migrations WHERE name LIKE '0021%'");
    expect(after).toEqual([]);
    const stillThere = await adminQuery<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY($1::text[])",
      [TABLES],
    );
    expect(stillThere[0]!.n).toBe(0);
  });
});

afterAll(async () => {
  await closePool();
});
