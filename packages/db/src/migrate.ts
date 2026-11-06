import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PgBoss } from "pg-boss";
import pg from "pg";
import { PGBOSS_SCHEMA, QUEUES } from "./queues";

// Applies migrations/*.sql in order, once each, as the owner role.
// Each file runs in its own transaction; a failure rolls that file back.
const url = process.env.DATABASE_URL_OWNER;
if (!url) {
  console.error("DATABASE_URL_OWNER is not set");
  process.exit(1);
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sqlText = await readFile(path.join(dir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sqlText);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }
  console.log(`migrations up to date (${files.length} files)`);
} finally {
  await client.end();
}

// Job queue: pg-boss creates and upgrades its own schema. That needs DDL
// rights, so it runs here as the owner; the app only gets DML on it.
const boss = new PgBoss({ connectionString: url, schema: PGBOSS_SCHEMA, supervise: false, schedule: false });
boss.on("error", (err) => console.error("pg-boss", err));
await boss.start();
// expireInSeconds: a job held longer than this by a worker that died is put
// back for retry by the worker's maintenance loop (see worker.ts).
const queueOptions = { retryLimit: 3, retryDelay: 5, retryBackoff: true, expireInSeconds: 300 };
for (const name of Object.values(QUEUES)) {
  if (await boss.getQueue(name)) await boss.updateQueue(name, queueOptions);
  else await boss.createQueue(name, queueOptions);
}
await boss.stop({ graceful: false });

const grants = new pg.Client({ connectionString: url });
await grants.connect();
try {
  await grants.query(`
    GRANT USAGE ON SCHEMA ${PGBOSS_SCHEMA} TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${PGBOSS_SCHEMA} TO app_user;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${PGBOSS_SCHEMA} TO app_user;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${PGBOSS_SCHEMA} TO app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA ${PGBOSS_SCHEMA} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
  `);
  console.log("job queue ready");
} finally {
  await grants.end();
}
