import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "../src/index";
import { adminQuery, ownerQuery } from "./helpers";

/** Applies proposed 0022 inside one transaction and rolls it back. Nothing is committed. */
const TABLES = ["integration_events", "dead_letters", "integration_breakers"] as const;

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

describe("proposed 0022 (rolled back, never applied)", () => {
  const sqlUp = statements("0022_events_and_dead_letters.sql");
  const sqlDown = statements("0022_events_and_dead_letters.down.sql");

  it("isolates event tables by tenant, then disappears on rollback", async () => {
    expect(await ownerQuery("SELECT name FROM schema_migrations WHERE name LIKE '0022%'")).toEqual([]);
    const client = new pg.Client({ connectionString: adminUrl() });
    await client.connect();
    const a = randomUUID();
    const b = randomUUID();
    try {
      await client.query("BEGIN");
      for (const statement of sqlUp) await client.query(statement);
      const forced = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[])`,
        [TABLES],
      );
      expect(forced.rows).toHaveLength(TABLES.length);
      for (const row of forced.rows) {
        expect(row.relrowsecurity, row.relname).toBe(true);
        expect(row.relforcerowsecurity, row.relname).toBe(true);
      }

      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [a]);
      await client.query("INSERT INTO organizations (id, name) VALUES ($1, 'Bus A')", [a]);
      await client.query(
        `INSERT INTO integration_events (tenant_id, idempotency_key, type, source, status) VALUES ($1, 'k1', 'weather.refresh', 'test', 'done')`,
        [a],
      );
      await client.query(
        `INSERT INTO dead_letters (tenant_id, event_key, type, source, error, attempts) VALUES ($1, 'k2', 'weather.refresh', 'test', 'down', 3)`,
        [a],
      );
      await client.query(
        `INSERT INTO integration_breakers (tenant_id, name, state, failures) VALUES ($1, 'nws', 'closed', 0)`,
        [a],
      );

      await client.query("SELECT set_config('app.tenant_id', $1, true)", [b]);
      await client.query("INSERT INTO organizations (id, name) VALUES ($1, 'Bus B')", [b]);
      const hidden = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM integration_events");
      expect(hidden.rows[0]!.n).toBe(0);
      await client.query("SAVEPOINT expect_fail");
      const denied = await client.query(
        `INSERT INTO dead_letters (tenant_id, event_key, type, source, error, attempts) VALUES ($1, 'stolen', 'x', 'y', 'z', 1)`,
        [a],
      ).then(() => undefined, (e: { message: string }) => e);
      await client.query("ROLLBACK TO SAVEPOINT expect_fail");
      expect(denied?.message).toMatch(/row-level security/);

      await client.query("RESET ROLE");
      for (const statement of sqlDown) await client.query(statement);
      const gone = await client.query<{ reg: string | null }>("SELECT to_regclass('public.dead_letters') AS reg");
      expect(gone.rows[0]!.reg).toBeNull();
      await client.query("ROLLBACK");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      await client.end();
    }
    expect(await ownerQuery("SELECT name FROM schema_migrations WHERE name LIKE '0022%'")).toEqual([]);
    const still = await adminQuery<{ n: number }>("SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY($1::text[])", [TABLES]);
    expect(still[0]!.n).toBe(0);
  });
});

afterAll(async () => {
  await closePool();
});
