// scripts/backup.mjs against the real test database: a backup is only real
// once it has been restored. Skipped unless postgres client tools exist
// (PG_BIN_DIR, or pg_dump on PATH) — CI/dev machines need postgresql-client.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * These tests shell out to pg_dump/psql and create + restore a scratch database, so they are
 * legitimately slower than the 5s default (~6s cold, ~1s warm here). They get their own budget,
 * tunable per environment, instead of raising the limit for the whole suite. A genuinely hung
 * subprocess still fails: scripts/backup.mjs has its own command timeouts.
 */
const SUBPROCESS_TEST_TIMEOUT_MS = Number(process.env.WOS_SUBPROCESS_TEST_TIMEOUT_MS ?? 30_000);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(root, "scripts", "backup.mjs");
const pgBinDir = process.env.PG_BIN_DIR ?? "";
const hasTools = pgBinDir
  ? true
  : (() => {
      try {
        execFileSync("pg_dump", ["--version"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();

// Backup role (scripts/setup-local-db.sql): BYPASSRLS + pg_read_all_data, so
// it can dump a forced-RLS database, and CREATEDB for restore verification.
const adminUrl = new URL(process.env.DATABASE_URL_ADMIN ?? "");
const backupUrl = `postgres://wos_backup:backup_dev_pw@${adminUrl.host}${adminUrl.pathname}`;

function runBackup(extraEnv: Record<string, string>, args: string[] = []) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: backupUrl, PG_BIN_DIR: pgBinDir, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    return { code: 0, output: stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe.skipIf(!hasTools)("scripts/backup.mjs", () => {
  it("dumps, restores into a scratch database, and verifies contents", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wos-backup-"));
    const r = runBackup({ BACKUP_DIR: dir });
    expect(r.output).toContain("restore verified");
    expect(r.code).toBe(0);
    const dumps = readdirSync(dir).filter((f) => f.endsWith(".dump"));
    expect(dumps).toHaveLength(1);
    expect(statSync(path.join(dir, dumps[0]!)).size).toBeGreaterThan(1024);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("rotates old dumps beyond the keep count", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wos-backup-"));
    // Two fake older dumps (timestamps sort before anything created now).
    for (const name of ["20000101-000000-wos_test-aaaa.dump", "20000102-000000-wos_test-bbbb.dump"]) {
      writeFileSync(path.join(dir, name), "x".repeat(2048));
    }
    const r = runBackup({ BACKUP_DIR: dir }, ["--keep", "1"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("rotated out 20000101-000000-wos_test-aaaa.dump");
    const remaining = readdirSync(dir).filter((f) => f.endsWith(".dump"));
    expect(remaining).toHaveLength(2); // the fresh dump + newest fake
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("fails closed on bad credentials and never leaks the password", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wos-backup-"));
    const badUrl = backupUrl.replace("backup_dev_pw", "definitely_wrong_pw");
    try {
      execFileSync(process.execPath, [script], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: badUrl, PG_BIN_DIR: pgBinDir, BACKUP_DIR: dir },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
      expect.unreachable("backup with bad credentials must fail");
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      expect(err.status).not.toBe(0);
      expect(`${err.stdout}${err.stderr}`).not.toContain("definitely_wrong_pw");
    }
    expect(readdirSync(dir).filter((f) => f.endsWith(".dump"))).toHaveLength(0);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("refuses to dump a newer server with older client tools", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wos-backup-"));
    const shimDir = mkdtempSync(path.join(tmpdir(), "wos-pgbin-"));
    for (const tool of ["pg_dump", "pg_restore", "psql"]) {
      const p = path.join(shimDir, tool);
      const body =
        tool === "pg_dump"
          ? '#!/bin/sh\necho "pg_dump (PostgreSQL) 9.6.24"\n'
          : tool === "psql"
            ? '#!/bin/sh\necho "18.6"\n'
            : "#!/bin/sh\nexit 0\n";
      writeFileSync(p, body);
      chmodSync(p, 0o755);
    }
    const r = runBackup({ BACKUP_DIR: dir, PG_BIN_DIR: shimDir });
    expect(r.code).toBe(1);
    expect(r.output).toContain("cannot dump");
  }, SUBPROCESS_TEST_TIMEOUT_MS);
});
