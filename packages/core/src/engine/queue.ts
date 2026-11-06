import { PgBoss } from "pg-boss";
import { PGBOSS_SCHEMA, QUEUES, type Tx } from "@wos/db";
import { logger } from "../logger";

export interface TaskRunJob {
  tenantId: string;
  taskId: string;
  /** Set on the delayed job that a RETRY_SCHEDULED task waits for. */
  retry?: boolean;
}

let starting: Promise<PgBoss> | undefined;
let workerId: string | undefined;

/** Queue client for the app role. Schema and queues are created by the migration step. */
export function getBoss(): Promise<PgBoss> {
  starting ??= (async () => {
    const boss = new PgBoss({
      connectionString: process.env.DATABASE_URL,
      schema: PGBOSS_SCHEMA,
      migrate: false,
      createSchema: false,
      schedule: false,
      supervise: process.env.WOS_QUEUE_SUPERVISE === "1",
    });
    boss.on("error", (err) => logger.error({ err }, "job queue error"));
    await boss.start();
    return boss;
  })();
  return starting;
}

export async function stopBoss(): Promise<void> {
  if (!starting) return;
  const boss = await starting;
  starting = undefined;
  await boss.stop({ graceful: true, timeout: 5000 });
}

/**
 * Enqueues a task run inside the caller's transaction: if the transaction
 * rolls back, the job never existed. That's the reason for a Postgres queue.
 */
export async function enqueueTaskRun(tx: Tx, job: TaskRunJob, opts: { startAfterSeconds?: number } = {}): Promise<void> {
  const boss = await getBoss();
  await boss.send(QUEUES.taskRun, { ...job }, {
    startAfter: opts.startAfterSeconds,
    db: { executeSql: (text: string, values?: unknown[]) => tx.raw.query(text, values as unknown[]) },
  });
}

/** Starts processing task runs in this process. */
export async function startTaskWorker(handler: (job: TaskRunJob) => Promise<void>, opts: { batchSize?: number; pollingIntervalSeconds?: number } = {}): Promise<void> {
  const boss = await getBoss();
  workerId = await boss.work<TaskRunJob>(QUEUES.taskRun, { batchSize: opts.batchSize ?? 1, pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 }, async (jobs) => {
    for (const job of jobs) await handler(job.data);
  });
}

export async function stopTaskWorker(): Promise<void> {
  if (!workerId || !starting) return;
  const boss = await starting;
  await boss.offWork(QUEUES.taskRun, { id: workerId, wait: true });
  workerId = undefined;
}
