#!/usr/bin/env node
// Runs the event-bus tests in durable mode (WOS_DURABLE_EVENTS=1) against a
// SCRATCH database: migrations/ + the PENDING proposed 0020-0023 SQL. The proposed
// SQL is never applied to the default test DB, dev, staging or production.
// Usage: ADMIN_URL=postgres://postgres@127.0.0.1:5432 node scripts/test-durable-events.mjs
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const pg = require("pg");

const ADMIN_URL = process.env.ADMIN_URL;
const DB = process.env.DB ?? "wos_test_durable";
if (!ADMIN_URL) {
  console.error("ADMIN_URL is required, e.g. postgres://postgres@127.0.0.1:5432");
  process.exit(1);
}
if (!/^[a-z0-9_]+$/.test(DB) || !/test|scratch/.test(DB)) {
  console.error("DB must be a scratch/test database name");
  process.exit(1);
}
const host = new URL(ADMIN_URL).host;
const OWNER = `postgres://wos_owner:owner_dev_pw@${host}/${DB}`;
const APP = `postgres://app_user:app_dev_pw@${host}/${DB}`;
const ADMIN_DB = `${ADMIN_URL}/${DB}`;

const admin = new pg.Client({ connectionString: `${ADMIN_URL}/postgres` });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB} OWNER wos_owner`);
await admin.end();

execFileSync("pnpm", ["--filter", "@wos/db", "migrate"], {
  env: { ...process.env, DATABASE_URL_OWNER: OWNER },
  stdio: ["ignore", "ignore", "inherit"],
});

const owner = new pg.Client({ connectionString: OWNER });
await owner.connect();
for (const f of [
  "0020_workspace_brand_and_watch.sql",
  "0021_industry_packs_and_speed.sql",
  "0022_events_and_dead_letters.sql",
  "0023_pilot_metrics.sql",
]) {
  await owner.query(readFileSync(path.resolve(import.meta.dirname, "../packages/db/proposed", f), "utf8"));
  console.log("applied (scratch only)", f);
}
await owner.end();

const files = [
  "packages/core/test/kimi.test.ts",
  "packages/core/test/producer-replay.test.ts",
  "packages/core/test/verify-fixes.test.ts",
];
execFileSync("npx", ["vitest", "run", ...files], {
  stdio: "inherit",
  env: {
    ...process.env,
    WOS_DURABLE_EVENTS: "1",
    TEST_DATABASE_URL: APP,
    TEST_DATABASE_URL_OWNER: OWNER,
    TEST_DATABASE_URL_ADMIN: ADMIN_DB,
  },
});
