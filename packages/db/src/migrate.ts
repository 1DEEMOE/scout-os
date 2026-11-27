import path from "node:path";
import { fileURLToPath } from "node:url";
import { PgBoss } from "pg-boss";
import pg from "pg";
import { applyMigrations } from "./migrate-runner";
import { PGBOSS_SCHEMA, QUEUES } from "./queues";

// Applies migrations/*.sql in order, once each, as the owner role (see migrate-runner.ts
// for the per-file transaction rule and the `-- migrate:no-transaction` opt-out).
const url = process.env.DATABASE_URL_OWNER;
if (!url) {
  console.error("DATABASE_URL_OWNER is not set");
  process.exit(1);
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await applyMigrations(client, dir);
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
