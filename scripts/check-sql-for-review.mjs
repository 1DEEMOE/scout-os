#!/usr/bin/env node
// Fails (exit 1) when sql-for-review/ has drifted from the SQL that will actually run.
//
//   sql-for-review/NNNN_name.sql       must be byte-identical to packages/db/migrations/NNNN_name.sql
//   sql-for-review/NNNN_name.down.sql  must be byte-identical to packages/db/rollback/NNNN_name.down.sql
//
// The folder is what the owner reviews, so a stale copy is a review of the wrong SQL.
// Rules:
//   1. every file in sql-for-review/ has a source and is byte-identical to it;
//   2. every migration numbered >= FIRST_REVIEWED, and its rollback if one exists, is present.
// Read-only: it never rewrites either side.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const review = join(root, "sql-for-review");
const ups = join(root, "packages/db/migrations");
const downs = join(root, "packages/db/rollback");
const FIRST_REVIEWED = 16;

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const problems = [];
const num = (name) => Number.parseInt(name.slice(0, 4), 10);
const sourceOf = (name) => join(name.endsWith(".down.sql") ? downs : ups, name);

const inReview = readdirSync(review).filter((f) => f.endsWith(".sql")).sort();
for (const name of inReview) {
  const src = sourceOf(name);
  if (!existsSync(src)) problems.push(`${name}: no source at ${src.replace(root + "/", "")}`);
  else if (sha(src) !== sha(join(review, name))) problems.push(`${name}: differs from ${src.replace(root + "/", "")}`);
}

const expected = [];
for (const f of readdirSync(ups).filter((x) => /^\d{4}_.*\.sql$/.test(x))) {
  if (num(f) < FIRST_REVIEWED) continue;
  expected.push(f);
  const down = f.replace(/\.sql$/, ".down.sql");
  if (existsSync(join(downs, down))) expected.push(down);
}
for (const f of expected) if (!inReview.includes(f)) problems.push(`${f}: missing from sql-for-review/`);

if (problems.length) {
  console.error(`sql-for-review is out of sync (${problems.length} problem${problems.length === 1 ? "" : "s"}):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("Copy the current file from packages/db/migrations or packages/db/rollback, then re-run: pnpm check:sql-review");
  process.exit(1);
}
console.log(`sql-for-review in sync: ${inReview.length} files byte-identical to their sources; ${expected.length} required files present.`);
