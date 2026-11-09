import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "../src/index";
import { ownerQuery } from "./helpers";

/**
 * Applies proposed 0024 (signal feeds and insurance claims) inside one
 * transaction, checks job_claims tenant isolation as app_user and the widened
 * kind checks, runs the rollback file, then rolls everything back. Nothing is
 * committed and schema_migrations is not touched.
 */
function sql(file: string): string {
  // The file's own BEGIN/COMMIT would end our outer transaction early.
  return readFileSync(path.resolve(import.meta.dirname, "../proposed", file), "utf8").replace(/^\s*(BEGIN|COMMIT);\s*$/gm, "");
}

function adminUrl(): string {
  if (process.env.DATABASE_URL_ADMIN) return process.env.DATABASE_URL_ADMIN;
  const app = new URL(process.env.DATABASE_URL ?? "postgres://app_user:app_dev_pw@127.0.0.1:5432/wos_test");
  app.username = "postgres";
  app.password = "";
  return app.toString();
}

async function fails(client: pg.Client, text: string, params: unknown[], pattern: RegExp) {
  await client.query("SAVEPOINT f");
  const err = await client.query(text, params).then(() => undefined, (e: unknown) => e as { message: string });
  await client.query("ROLLBACK TO SAVEPOINT f");
  expect(err, "expected the statement to fail").toBeDefined();
  expect(err?.message).toMatch(pattern);
}

const checkDef = async (client: pg.Client, name: string) =>
  (await client.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1", [name])).rows[0]?.def ?? "";

describe("proposed 0024 (rolled back, never applied)", () => {
  afterAll(async () => {
    await closePool();
  });

  it("isolates job_claims by tenant, widens the feed kinds, and the rollback restores everything", async () => {
    expect(await ownerQuery("SELECT name FROM schema_migrations WHERE name LIKE '0024%'")).toEqual([]);
    const client = new pg.Client({ connectionString: adminUrl() });
    await client.connect();
    const a = randomUUID();
    const b = randomUUID();
    const taskA = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(sql("0024_signal_feeds_and_claims.sql"));
      expect(await checkDef(client, "signal_observations_kind_check")).toContain("permit");
      expect(await checkDef(client, "intelligence_sources_kind_check")).toContain("mock_permit_feed");
      const rls = await client.query<{ r: boolean; f: boolean }>("SELECT relrowsecurity AS r, relforcerowsecurity AS f FROM pg_class WHERE relname = 'job_claims'");
      expect(rls.rows[0]).toEqual({ r: true, f: true });

      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [a]);
      await client.query("INSERT INTO organizations (id, name) VALUES ($1, 'Claims A')", [a]);
      await client.query("INSERT INTO tasks (id, tenant_id, requested_by, intent) VALUES ($1, $2, 'u-a', 'Insurance job')", [taskA, a]);
      await client.query("INSERT INTO job_claims (tenant_id, job_id, carrier, claim_number, created_by) VALUES ($1, $2, 'Example Mutual', 'CLM-1', 'u-a')", [a, taskA]);
      await fails(client, "DELETE FROM job_claims", [], /permission denied/); // app_user may not delete claims

      await client.query("SELECT set_config('app.tenant_id', $1, true)", [b]);
      await client.query("INSERT INTO organizations (id, name) VALUES ($1, 'Claims B')", [b]);
      expect((await client.query<{ n: number }>("SELECT count(*)::int AS n FROM job_claims")).rows[0]!.n).toBe(0);
      await fails(client, "INSERT INTO job_claims (tenant_id, job_id, created_by) VALUES ($1, $2, 'u-b')", [a, taskA], /row-level security/);
      await fails(client, "INSERT INTO job_claims (tenant_id, job_id, created_by) VALUES ($1, $2, 'u-b')", [b, taskA], /foreign key|row-level security/);
      await fails(client, "INSERT INTO job_claims (tenant_id, job_id, carrier, created_by) VALUES ($1, $2, repeat('x', 200), 'u-b')", [b, randomUUID()], /check constraint|foreign key/);

      await client.query("RESET ROLE");
      await client.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [[a, b]]);
      await client.query(sql("0024_signal_feeds_and_claims.down.sql"));
      expect((await client.query<{ reg: string | null }>("SELECT to_regclass('public.job_claims') AS reg")).rows[0]!.reg).toBeNull();
      expect(await checkDef(client, "signal_observations_kind_check")).not.toContain("permit");
      await client.query("ROLLBACK");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      await client.end();
    }
    expect(await ownerQuery("SELECT name FROM schema_migrations WHERE name LIKE '0024%'")).toEqual([]);
  });
});
