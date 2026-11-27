#!/usr/bin/env node
// Database backup with restore verification and rotation.
//
//   node scripts/backup.mjs [--no-verify] [--keep N] [--dir PATH]
//
// Env:
//   DATABASE_URL | BACKUP_DATABASE_URL  connection string (never logged with credentials)
//   PG_BIN_DIR                          directory holding pg_dump/pg_restore/psql (default: PATH)
//   BACKUP_DIR                          where dumps are written (default: ./backups)
//   BACKUP_KEEP                         number of dumps to retain (default: 14)
//   BACKUP_TIMEOUT_MS                   per-step timeout (default: 15 minutes)
//
// A backup that has never been restored is a hypothesis, not a backup. Every
// run restores the fresh dump into a scratch database on the same server,
// sanity-checks it, and drops it. Any failure exits non-zero — an unverified
// backup must never look like success to cron.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

if (flag("--help")) {
  console.log("usage: node scripts/backup.mjs [--no-verify] [--keep N] [--dir PATH]");
  process.exit(0);
}

const KEEP = Number.parseInt(option("--keep", process.env.BACKUP_KEEP ?? "14"), 10);
const DIR = path.resolve(option("--dir", process.env.BACKUP_DIR ?? "backups"));
const VERIFY = !flag("--no-verify");
const TIMEOUT_MS = Number.parseInt(process.env.BACKUP_TIMEOUT_MS ?? String(15 * 60 * 1000), 10);
const BIN = process.env.PG_BIN_DIR ?? "";
const tool = (name) => (BIN ? path.join(BIN, name) : name);

const rawUrl = process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL;
if (!rawUrl) fail("DATABASE_URL (or BACKUP_DATABASE_URL) is required");
if (!Number.isInteger(KEEP) || KEEP < 1) fail(`invalid keep count: ${KEEP}`);
if (!Number.isInteger(TIMEOUT_MS) || TIMEOUT_MS < 10_000) fail(`invalid BACKUP_TIMEOUT_MS: ${TIMEOUT_MS}`);

let url;
try {
  url = new URL(rawUrl);
} catch {
  fail("DATABASE_URL is not a valid URL");
}
const dbName = url.pathname.replace(/^\//, "");
if (!dbName) fail("DATABASE_URL has no database name");

const log = (msg) => console.log(`[backup] ${msg}`);
const redacted = `${url.hostname}:${url.port || 5432}/${dbName}`;

function fail(msg, code = 1) {
  console.error(`[backup] ERROR: ${msg}`);
  process.exit(code);
}

/** Run a postgres client tool. Password only ever travels via PGPASSWORD env. */
function run(toolName, toolArgs, { input } = {}) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.BACKUP_DATABASE_URL;
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  return new Promise((resolve, reject) => {
    const child = execFile(
      tool(toolName),
      toolArgs,
      { env, timeout: TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).trim().split("\n").slice(-3).join(" | ");
          reject(new Error(`${toolName} failed: ${detail}`));
        } else {
          resolve(stdout);
        }
      },
    );
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

const connArgs = (dbname) => [
  "--host", url.hostname,
  "--port", url.port || "5432",
  "--username", decodeURIComponent(url.username),
  "--dbname", dbname,
];

/** Single-value SQL query via psql; returns trimmed stdout. */
async function sql(dbname, query) {
  const out = await run("psql", [...connArgs(dbname), "--no-psqlrc", "--tuples-only", "--no-align", "--command", query]);
  return out.trim();
}

async function rotate() {
  const files = (await readdir(DIR))
    .filter((f) => /^\d{8}-\d{6}-.+(?:-[0-9a-f]{4})?\.dump$/.test(f))
    .sort();
  const excess = files.length - KEEP;
  for (const f of files.slice(0, Math.max(0, excess))) {
    await unlink(path.join(DIR, f));
    log(`rotated out ${f}`);
  }
}

async function main() {
  const startedAt = Date.now();
  await mkdir(DIR, { recursive: true });

  const serverVersion = await sql(dbName, "SHOW server_version").catch((e) => fail(`cannot connect to ${redacted}: ${e.message}`));
  const toolVersion = (await run("pg_dump", ["--version"]).catch((e) => fail(e.message))).trim();
  log(`server ${redacted} (PostgreSQL ${serverVersion}); ${toolVersion}`);
  const toolMajor = Number.parseInt(toolVersion.match(/(\d+)\./)?.[1] ?? "", 10);
  const serverMajor = Number.parseInt(serverVersion.split(".")[0] ?? "", 10);
  if (!Number.isInteger(serverMajor)) fail(`could not parse server version: ${JSON.stringify(serverVersion)}`);
  if (!Number.isInteger(toolMajor)) fail(`could not parse pg_dump version: ${JSON.stringify(toolVersion)}`);
  if (toolMajor < serverMajor) {
    fail(`pg_dump ${toolMajor} cannot dump PostgreSQL ${serverMajor} — install matching client tools or set PG_BIN_DIR`);
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  // Random suffix: two runs in the same second must never overwrite each other.
  const file = path.join(DIR, `${stamp}-${dbName}-${randomBytes(2).toString("hex")}.dump`);
  log(`dumping ${redacted} -> ${path.relative(process.cwd(), file)}`);
  await run("pg_dump", [...connArgs(dbName), "--format=custom", "--no-owner", "--no-privileges", "--file", file]).catch((e) => fail(e.message));
  const { size } = await stat(file);
  if (size < 1024) fail(`dump suspiciously small (${size} bytes) — refusing to trust it`);
  log(`dump complete: ${(size / 1024).toFixed(0)} KiB`);

  if (VERIFY) {
    const scratch = `wos_backup_verify_${randomBytes(4).toString("hex")}`;
    log(`verifying restore into scratch database ${scratch}`);
    try {
      await sql("postgres", `CREATE DATABASE "${scratch}"`).catch((e) => fail(`cannot create scratch db (needs CREATEDB): ${e.message}`));
      await run("pg_restore", [...connArgs(scratch), "--no-owner", "--no-privileges", "--exit-on-error", file]).catch((e) => fail(`restore failed: ${e.message}`));
      const [srcTables, dstTables] = await Promise.all([
        sql(dbName, "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')"),
        sql(scratch, "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')"),
      ]);
      if (srcTables !== dstTables) fail(`restore check failed: source has ${srcTables} tables, restored ${dstTables}`);
      if (Number.parseInt(dstTables, 10) < 1) fail("restore check failed: no tables restored");
      const srcMigrations = await sql(dbName, "SELECT count(*) FROM schema_migrations").catch(() => null);
      if (srcMigrations !== null) {
        const dstMigrations = await sql(scratch, "SELECT count(*) FROM schema_migrations");
        if (srcMigrations !== dstMigrations) fail(`restore check failed: source has ${srcMigrations} migrations, restored ${dstMigrations}`);
      }
      log(`restore verified: ${dstTables} tables${srcMigrations !== null ? `, ${srcMigrations} migrations` : ""}`);
    } finally {
      await sql("postgres", `DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch((e) => console.error(`[backup] WARN: scratch cleanup failed: ${e.message}`));
    }
  } else {
    log("WARNING: restore verification skipped (--no-verify) — this backup is unverified");
  }

  await rotate();
  log(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((e) => fail(e.message));
