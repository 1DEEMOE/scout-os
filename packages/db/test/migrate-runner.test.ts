import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, splitStatements, wantsNoTransaction } from "../src/migrate-runner";

// Runs in a throwaway schema (the owner role cannot create databases); nothing touches the
// real tables. search_path puts schema_migrations and the test tables inside it.
const ownerUrl = process.env.DATABASE_URL_OWNER!;
const scratch = `migrate_runner_${process.pid}`;
let dir = "";

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>, schema?: string): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  if (schema) await c.query(`SET search_path TO ${schema}`);
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
async function files(map: Record<string, string>) {
  await rm(dir, { recursive: true, force: true });
  dir = await mkdtemp(path.join(os.tmpdir(), "mig-"));
  for (const [n, s] of Object.entries(map)) await writeFile(path.join(dir, n), s);
}

describe("migration runner", () => {
  beforeAll(async () => {
    await withClient(ownerUrl, (c) => c.query(`CREATE SCHEMA ${scratch}`));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await withClient(ownerUrl, (c) => c.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`));
  });

  it("detects the marker only in the leading comment block", () => {
    expect(wantsNoTransaction("-- migrate:no-transaction\nCREATE INDEX x ON t(a);")).toBe(true);
    expect(wantsNoTransaction("-- 0099 note\n\n--   migrate:no-transaction  \nSELECT 1;")).toBe(true);
    expect(wantsNoTransaction("SELECT 1;\n-- migrate:no-transaction")).toBe(false);
    expect(wantsNoTransaction("-- plain header\nSELECT 1;")).toBe(false);
  });

  it("splits statements, ignoring comments, quotes and semicolons inside them", () => {
    const parts = splitStatements("-- c; x\nSELECT 'a;b'; /* ; */ SELECT \"c;d\", 'it''s;ok';\nSELECT 3");
    expect(parts).toEqual(["SELECT 'a;b'", "SELECT \"c;d\", 'it''s;ok'", "SELECT 3"]);
    expect(() => splitStatements("SELECT $$a;b$$")).toThrow(/dollar/);
  });

  it("control: CREATE INDEX CONCURRENTLY fails inside the normal per-file transaction and nothing is recorded", async () => {
    await files({
      "0001_t.sql": "CREATE TABLE t (id int, a int);",
      "0002_idx.sql": "CREATE INDEX CONCURRENTLY t_a_idx ON t (a);",
    });
    await withClient(ownerUrl, async (c) => {
      await expect(applyMigrations(c, dir, () => undefined)).rejects.toThrow(/CONCURRENTLY cannot run inside a transaction block/);
      const done = (await c.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map((r) => r.name);
      expect(done).toEqual(["0001_t.sql"]);
    }, scratch);
  });

  it("with the marker the same statement runs, the index is valid, and re-running is a no-op", async () => {
    await files({
      "0001_t.sql": "CREATE TABLE t2 (id int, a int);",
      "0002_idx.sql": "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t2_a_idx ON t2 (a);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t2_id_idx ON t2 (id);",
    });
    await withClient(ownerUrl, async (c) => {
      await c.query("DELETE FROM schema_migrations");
      const first = await applyMigrations(c, dir, () => undefined);
      expect(first.applied).toEqual(["0001_t.sql", "0002_idx.sql"]);
      const idx = await c.query("SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = 't2'::regclass ORDER BY 1");
      expect(idx.rows).toEqual([{ relname: "t2_a_idx", indisvalid: true }, { relname: "t2_id_idx", indisvalid: true }]);
      expect((await applyMigrations(c, dir, () => undefined)).applied).toEqual([]);
    }, scratch);
  });

  it("a no-transaction file that fails midway is not recorded, and is safe to re-run once fixed", async () => {
    await files({
      "0001_t.sql": "CREATE TABLE t3 (id int, a int);",
      "0002_idx.sql": "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t3_a_idx ON t3 (a);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t3_bad_idx ON t3 (missing_col);",
    });
    await withClient(ownerUrl, async (c) => {
      await c.query("DELETE FROM schema_migrations");
      await expect(applyMigrations(c, dir, () => undefined)).rejects.toThrow(/missing_col/);
      expect((await c.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name)).toEqual(["0001_t.sql"]);
      await files({
        "0001_t.sql": "CREATE TABLE t3 (id int, a int);",
        "0002_idx.sql": "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t3_a_idx ON t3 (a);",
      });
      expect((await applyMigrations(c, dir, () => undefined)).applied).toEqual(["0002_idx.sql"]);
    }, scratch);
  });
});
