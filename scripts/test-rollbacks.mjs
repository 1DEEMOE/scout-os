#!/usr/bin/env node
// Node port of scripts/test-rollbacks.sh for machines without psql/pg_dump.
// Round-trip check: migrate up, run every rollback newest-first, migrate up,
// and require the schema snapshot (tables, columns, indexes, constraints,
// policies, RLS flags, grants) to match the first pass.
// Usage: ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432 DB=scratch_db node scripts/test-rollbacks.mjs
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// pg is a dependency of @wos/db; resolve it from there (pnpm keeps no root copy).
const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const pg = require("pg");

const ADMIN_URL = process.env.ADMIN_URL;
const DB = process.env.DB;
if (!ADMIN_URL || !DB) {
  console.error("ADMIN_URL and DB are required");
  process.exit(1);
}
const OWNER = `postgres://wos_owner:owner_dev_pw@${new URL(ADMIN_URL).host}/${DB}`;

const admin = new pg.Client({ connectionString: `${ADMIN_URL}/postgres` });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB} OWNER wos_owner`);
await admin.end();

const migrate = () =>
  execFileSync("pnpm", ["--filter", "@wos/db", "migrate"], {
    env: { ...process.env, DATABASE_URL_OWNER: OWNER },
    stdio: ["ignore", "ignore", "inherit"],
  });

async function snapshot() {
  const c = new pg.Client({ connectionString: OWNER });
  await c.connect();
  const q = (sql) => c.query(sql).then((r) => r.rows);
  const tables = await q(`SELECT tablename, tableowner FROM pg_tables WHERE schemaname='public' ORDER BY 1`);
  const columns = await q(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY 1,2`);
  const indexes = await q(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1,2`);
  const constraints = await q(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2`);
  const policies = await q(`SELECT tablename, policyname, permissive, roles, qual, with_check FROM pg_policies WHERE schemaname='public' ORDER BY 1,2`);
  const rls = await q(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1`);
  const grants = await q(`SELECT table_name, grantee, privilege_type FROM information_schema.table_privileges WHERE table_schema='public' ORDER BY 1,2,3`);
  const migrations = await q(`SELECT name FROM schema_migrations ORDER BY 1`);
  await c.end();
  return JSON.stringify({ tables, columns, indexes, constraints, policies, rls, grants, migrations }, null, 1);
}

migrate();
const up1 = await snapshot();

const owner = new pg.Client({ connectionString: OWNER });
await owner.connect();
const dir = path.join(import.meta.dirname, "../packages/db/rollback");
const files = readdirSync(dir).filter((f) => f.endsWith(".down.sql")).sort().reverse();
for (const f of files) {
  await owner.query(readFileSync(path.join(dir, f), "utf8"));
  console.log(`rolled back ${f}`);
}
const left = await owner.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name >= '0009'`);
if (left.rows[0].n !== 0) {
  console.error(`FAIL: ${left.rows[0].n} rolled-back migrations still recorded`);
  process.exit(1);
}
await owner.end();

migrate();
const up2 = await snapshot();

if (up1 !== up2) {
  console.error("FAIL: rollback round-trip schema differs");
  process.exit(1);
}
console.log("PASS: rollback round-trip schema identical");
