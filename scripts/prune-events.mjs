#!/usr/bin/env node
// Owner-run retention for the durable event tables. The app role has no DELETE on them (by design),
// so nothing prunes automatically; run this by hand or from a privileged scheduled job.
// NEEDS a connection that can see every tenant's rows AND delete: a superuser or a BYPASSRLS role
// with DELETE. The table owner (wos_owner) is NOT enough: these tables FORCE row-level security, so
// it would see zero rows. (Dry run first: a count of 0 on a busy system means the wrong role.)
//
//   DATABASE_URL_ADMIN=postgres://... node scripts/prune-events.mjs            # dry run: counts only
//   DATABASE_URL_ADMIN=postgres://... node scripts/prune-events.mjs --apply    # delete
//   flags: --events-days=90 --dead-letter-days=90 --batch=1000
//
// Policy (defaults chosen by the project owner's PM, change freely):
//   integration_events: only status done/skipped older than --events-days (90). 'dead',
//     'in_progress' and 'failed' rows are never pruned: they are the idempotency record or live work.
//   dead_letters: only rows already replayed (replayed_at set) older than --dead-letter-days (90).
//     Unreplayed dead letters are never pruned: they are open problems.
// Deleting a done event allows the same idempotency key to run again, so keep the window longer
// than any provider-side retry or replay horizon. Output is counts only: no keys, no tenant ids.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export async function prune(client, { eventsDays = 90, deadLetterDays = 90, batch = 1000, apply = false } = {}) {
  for (const [n, v] of [["eventsDays", eventsDays], ["deadLetterDays", deadLetterDays], ["batch", batch]]) {
    if (!Number.isInteger(v) || v < 1) throw new Error(`${n} must be a positive integer`);
  }
  const specs = [
    { name: "integration_events", days: eventsDays,
      where: "status IN ('done','skipped') AND created_at < now() - ($1 * interval '1 day')" },
    { name: "dead_letters", days: deadLetterDays,
      where: "replayed_at IS NOT NULL AND replayed_at < now() - ($1 * interval '1 day')" },
  ];
  const out = {};
  for (const s of specs) {
    if (!apply) {
      out[s.name] = Number((await client.query(`SELECT count(*) AS n FROM ${s.name} WHERE ${s.where}`, [s.days])).rows[0].n);
      continue;
    }
    let total = 0;
    for (;;) {
      const r = await client.query(
        `DELETE FROM ${s.name} WHERE ctid IN (SELECT ctid FROM ${s.name} WHERE ${s.where} LIMIT ${batch})`, [s.days]);
      total += r.rowCount;
      if (r.rowCount < batch) break;
    }
    out[s.name] = total;
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
  const pg = require("pg");
  const url = process.env.DATABASE_URL_ADMIN;
  if (!url) { console.error("DATABASE_URL_ADMIN is required"); process.exit(1); }
  const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split("=")[1]) : d; };
  const apply = process.argv.includes("--apply");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await prune(client, { eventsDays: arg("events-days", 90), deadLetterDays: arg("dead-letter-days", 90), batch: arg("batch", 1000), apply });
    console.log(`${apply ? "DELETED" : "DRY RUN, would delete"}:`, JSON.stringify(res));
    if (!apply) console.log("Re-run with --apply to delete.");
  } finally { await client.end(); }
}
