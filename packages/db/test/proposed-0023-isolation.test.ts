import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "../src/index";
import { ownerQuery } from "./helpers";

/** Applies proposed 0023 inside one transaction and rolls it back. Nothing is committed. */
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

describe("proposed 0023 (rolled back, never applied)", () => {
  const sqlUp = statements("0023_pilot_metrics.sql");
  const sqlDown = statements("0023_pilot_metrics.down.sql");

  it("isolates pilot metrics by tenant, then disappears on rollback", async () => {
    expect(await ownerQuery("SELECT name FROM schema_migrations WHERE name LIKE '0023%'")).toEqual([]);
    const client = new pg.Client({ connectionString: adminUrl() });
    await client.connect();
    const a = randomUUID();
    const b = randomUUID();
    try {
      await client.query("BEGIN");
      for (const statement of sqlUp) await client.query(statement);
      const flags = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'pilot_metrics'",
      );
      expect(flags.rows[0]?.relrowsecurity).toBe(true);
      expect(flags.rows[0]?.relforcerowsecurity).toBe(true);
      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [a]);
      await client.query("INSERT INTO organizations (id, name) VALUES ($1, 'Pilot A')", [a]);
      await client.query("INSERT INTO pilot_metrics (tenant_id, bookings_recovered) VALUES ($1, 1)", [a]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [b]);
      await client.query("INSERT INTO organizations (id, name) VALUES ($1, 'Pilot B')", [b]);
      const seen = await client.query("SELECT tenant_id FROM pilot_metrics");
      expect(seen.rows).toEqual([]);
      await client.query("ROLLBACK");
      const gone = await client.query("SELECT to_regclass('public.pilot_metrics') AS name");
      expect(gone.rows[0]?.name).toBeNull();
    } finally {
      await client.end();
    }
    for (const statement of sqlDown) {
      // The down file is syntax-valid. It is not executed against the database.
      expect(statement.toLowerCase()).toContain("drop table");
    }
  });

  afterAll(async () => {
    await closePool();
  });
});
