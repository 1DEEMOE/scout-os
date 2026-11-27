import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "pg";

/**
 * Applies migrations/*.sql in name order, once each, as the owner role.
 *
 * Default: each file runs in its own transaction; a failure rolls that file back.
 *
 * Opt-out for statements Postgres refuses inside a transaction, chiefly
 * `CREATE INDEX CONCURRENTLY` (builds an index without blocking writes to a busy
 * table). Put this line in the file's leading comment block:
 *
 *     -- migrate:no-transaction
 *
 * Then every statement runs on its own with no BEGIN/COMMIT. A multi-statement
 * query string is ONE implicit transaction, so the file is split into statements
 * here. Rules for such a file (checked, not assumed):
 *   - plain statements only: no dollar-quoted bodies ($$ ... $$);
 *   - it is not atomic. If statement 2 fails, statement 1 stays applied and the file
 *     is NOT recorded, so write every statement to be safely re-runnable
 *     (CREATE INDEX CONCURRENTLY IF NOT EXISTS ...). A concurrent build that fails
 *     leaves an INVALID index behind: drop it, then re-run.
 *   - keep the file to that one concern; put ordinary DDL in a normal file.
 */
export const NO_TRANSACTION_MARKER = "-- migrate:no-transaction";

/** True when the marker appears in the file's leading comment block (before any statement). */
export function wantsNoTransaction(sqlText: string): boolean {
  for (const line of sqlText.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    if (!t.startsWith("--")) return false;
    if (t.replace(/\s+/g, " ").toLowerCase() === NO_TRANSACTION_MARKER) return true;
  }
  return false;
}

/**
 * Splits SQL into statements on top-level semicolons, ignoring `--` and block comments and
 * single/double-quoted text. Dollar-quoting is rejected rather than half-supported.
 */
export function splitStatements(sqlText: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sqlText.length) {
    const c = sqlText[i]!;
    const next = sqlText[i + 1];
    if (c === "-" && next === "-") {
      const end = sqlText.indexOf("\n", i);
      i = end === -1 ? sqlText.length : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sqlText.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated /* comment");
      i = end + 2;
      continue;
    }
    if (c === "$" && /^\$[A-Za-z_]*\$/.test(sqlText.slice(i))) {
      throw new Error("dollar-quoted text is not supported in a no-transaction migration");
    }
    if (c === "'" || c === '"') {
      const close = c;
      cur += c;
      i++;
      while (i < sqlText.length) {
        cur += sqlText[i];
        if (sqlText[i] === close) {
          if (sqlText[i + 1] === close) {
            cur += sqlText[i + 1]; // doubled quote is an escape
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface MigrationReport {
  applied: string[];
  total: number;
}

export async function applyMigrations(client: Client, dir: string, log: (line: string) => void = console.log): Promise<MigrationReport> {
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sqlText = await readFile(path.join(dir, file), "utf8");
    if (wantsNoTransaction(sqlText)) {
      for (const statement of splitStatements(sqlText)) await client.query(statement);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    } else {
      await client.query("BEGIN");
      try {
        await client.query(sqlText);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    applied.push(file);
    log(`applied ${file}`);
  }
  log(`migrations up to date (${files.length} files)`);
  return { applied, total: files.length };
}
