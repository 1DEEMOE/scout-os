#!/usr/bin/env node
/**
 * One-command local setup: `pnpm setup`.
 *
 *   node scripts/bootstrap.mjs [--db-url postgres://user:pw@host:5432/postgres]
 *                              [--out apps/web/.env.local] [--skip-install]
 *                              [--no-mock] [--demo]
 *
 * What it does, in order, stopping at the first real failure:
 *   1. preflight  — Node 22+ and pnpm (unless --skip-install)
 *   2. install    — pnpm install --frozen-lockfile
 *   3. env file   — apps/web/.env.local from .env.example with GENERATED
 *                   secrets (never echoes them) and DB URLs matching --db-url
 *   4. database   — roles + databases from scripts/setup-local-db.sql
 *                   (idempotent: existing roles/databases are kept)
 *   5. migrate    — applies packages/db migrations to wos_dev as wos_owner
 *   6. verify     — connects as the least-privilege app role and reads the
 *                   schema, proving the whole chain works
 *
 * It uses the repo's own `pg` dependency, so no psql install is needed.
 * Re-running is safe; nothing existing is overwritten (the env file is kept,
 * roles/databases are reused, migrations are incremental).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const flag = (name) => args.includes(`--${name}`);

const DB_URL = opt("db-url", "postgres://postgres:postgres@localhost:5432/postgres");
const ENV_FILE = opt("out", "apps/web/.env.local");
const SKIP_INSTALL = flag("skip-install");
const MOCK = !flag("no-mock");
const DEMO = flag("demo");

const root = new URL("..", import.meta.url).pathname;
const requireFromDb = createRequire(new URL("../packages/db/package.json", import.meta.url));

let step = 0;
const STEPS = 6 + (DEMO ? 1 : 0);
function say(msg) {
  console.log(`\n[${++step}/${STEPS}] ${msg}`);
}
function ok(msg) {
  console.log(`    ✓ ${msg}`);
}
function die(msg, hint) {
  console.error(`\n✗ ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: opts.quiet ? "pipe" : "inherit", env: { ...process.env, ...(opts.env ?? {}) }, shell: false });
  if (r.error) die(`could not run ${cmd}: ${r.error.message}`, opts.hint);
  if (r.status !== 0) die(`${cmd} ${cmdArgs.join(" ")} failed (exit ${r.status})`, opts.hint);
  return r;
}

/* 1 — preflight -------------------------------------------------------- */
say("preflight");
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) die(`Node 22+ is required (this is ${process.version})`, "Install Node 22: https://nodejs.org");
ok(`node ${process.version}`);
if (!SKIP_INSTALL) {
  const pnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
  if (pnpm.status !== 0) die("pnpm not found", "Enable it with: corepack enable && corepack prepare pnpm@10 --activate");
  ok(`pnpm ${pnpm.stdout.trim()}`);
}

/* 2 — install ---------------------------------------------------------- */
if (!SKIP_INSTALL) {
  say("dependencies");
  run("pnpm", ["install", "--frozen-lockfile"], { hint: "If the lockfile is stale, run plain `pnpm install` once and commit the result." });
  ok("node_modules ready");
}

/* 3 — env file --------------------------------------------------------- */
say(`env file (${ENV_FILE})`);
const dbAdmin = new URL(DB_URL);
const dbHost = dbAdmin.hostname;
const dbPort = dbAdmin.port || "5432";
const ownerUrl = `postgres://wos_owner:owner_dev_pw@${dbHost}:${dbPort}/wos_dev`;
const envPath = ENV_FILE.startsWith("/") ? ENV_FILE : new URL(`../${ENV_FILE}`, import.meta.url).pathname;
if (existsSync(envPath)) {
  ok("already exists — kept as-is (delete it and re-run to regenerate)");
} else {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const secrets = {
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    WOS_SECRETS_KEY: randomBytes(32).toString("base64"),
  };
  let env = example
    .replace(`DATABASE_URL=postgres://app_user:app_dev_pw@localhost:5432/wos_dev`, `DATABASE_URL=postgres://app_user:app_dev_pw@${dbHost}:${dbPort}/wos_dev`)
    .replace(`DATABASE_URL_OWNER=postgres://wos_owner:owner_dev_pw@localhost:5432/wos_dev`, `DATABASE_URL_OWNER=${ownerUrl}`)
    .replace(`DATABASE_URL_ADMIN=postgres://postgres@localhost:5432/wos_dev`, `DATABASE_URL_ADMIN=postgres://${encodeURIComponent(dbAdmin.username)}:${encodeURIComponent(dbAdmin.password)}@${dbHost}:${dbPort}/wos_dev`)
    .replace("BETTER_AUTH_SECRET=replace-with-32+-random-characters", `BETTER_AUTH_SECRET=${secrets.BETTER_AUTH_SECRET}`)
    .replace("WOS_SECRETS_KEY=", `WOS_SECRETS_KEY=${secrets.WOS_SECRETS_KEY}`);
  if (MOCK && !/^WOS_MOCK_MODE=1$/m.test(env)) env = env.replace(/^# WOS_MOCK_MODE=1$/m, "WOS_MOCK_MODE=1");
  writeFileSync(envPath, env, { mode: 0o600 });
  ok("created with generated secrets (MOCK mode " + (MOCK ? "on — no external accounts needed" : "off") + ")");
}

/* 4 — database roles + databases --------------------------------------- */
say("database roles and databases");
const pg = requireFromDb("pg");
async function withClient(connectionString, fn) {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}
const sql = readFileSync(new URL("../scripts/setup-local-db.sql", import.meta.url), "utf8");
const statements = sql
  .split(/;\s*(?:\r?\n|$)/)
  .map((s) => s.replace(/^--[^\n]*$/gm, "").trim())
  .filter(Boolean);
try {
  await withClient(DB_URL, async (client) => {
    for (const stmt of statements) {
      try {
        await client.query(stmt);
      } catch (err) {
        // 42710 duplicate object (role), 42P04 duplicate database: fine on re-run.
        if (err.code === "42710" || err.code === "42P04") continue;
        throw err;
      }
    }
  });
  ok(`roles and databases ready on ${dbHost}:${dbPort}`);
} catch (err) {
  die(`could not prepare the database: ${err.message}`, `Pass a superuser URL: --db-url postgres://user:pw@host:5432/postgres (Docker quickstart: docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16)`);
}

/* 5 — migrate ----------------------------------------------------------- */
say("migrations (wos_dev)");
run("pnpm", ["--filter", "@wos/db", "migrate"], { env: { DATABASE_URL_OWNER: ownerUrl }, hint: "Migrations run as wos_owner; check DATABASE_URL_OWNER." });
ok("schema up to date");

/* 6 — verify ------------------------------------------------------------ */
say("verification (connecting as the least-privilege app role)");
try {
  const n = await withClient(`postgres://app_user:app_dev_pw@${dbHost}:${dbPort}/wos_dev`, async (client) => {
    const r = await client.query("SELECT count(*)::int AS n FROM organizations");
    return r.rows[0].n;
  });
  ok(`app role reads the schema (organizations visible to this role: ${n})`);
} catch (err) {
  die(`verification failed: ${err.message}`, "The database is up but the app role cannot read the schema — re-run or check scripts/setup-local-db.sql.");
}

/* 7 — optional demo seed ------------------------------------------------- */
if (DEMO) {
  say("demo seed (synthetic accounts)");
  run("pnpm", ["--filter", "@wos/web", "exec", "tsx", "e2e/demo-seed.ts"], { env: { DATABASE_URL: `postgres://app_user:app_dev_pw@${dbHost}:${dbPort}/wos_dev`, DATABASE_URL_OWNER: ownerUrl }, hint: "Demo seed runs from apps/web with the dev database env." });
  ok("demo data loaded (owner@e2e.test / sam@e2e.test, password e2e-password-12345)");
}

console.log(`
Setup complete. Start Ascend Software locally:

  pnpm --filter @wos/web dev        → http://localhost:3000
  pnpm --filter @wos/web worker     → routines, storm sync, recovery (2nd terminal)

Env: ${ENV_FILE}${MOCK ? " (MOCK mode — every external service is a labelled mock)" : ""}
Runtime health check: http://localhost:3000/api/healthz
`);
