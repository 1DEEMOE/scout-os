import { QUEUES, type Tx } from "@wos/db";
import { getBoss } from "../engine/queue";

export interface RoutineRunJob {
  tenantId: string;
  routineId: string;
  /** ISO instant this run is for. A job whose time no longer matches the routine is stale and ignored. */
  scheduledFor: string;
  trigger: "schedule" | "manual";
  /** Manual runs only: the caller's idempotency reference. */
  clientRef?: string;
}

let workerId: string | undefined;

/** Enqueued inside the caller's transaction: rolls back with it. */
export async function enqueueRoutineRun(tx: Tx, job: RoutineRunJob, opts: { startAfter?: Date } = {}): Promise<void> {
  const boss = await getBoss();
  await boss.send(QUEUES.routineRun, { ...job }, {
    ...(opts.startAfter ? { startAfter: opts.startAfter } : {}),
    // pg-boss-level dedupe for the same scheduled instant; the run table's unique key is the real guarantee.
    singletonKey: `${job.routineId}:${job.trigger}:${job.trigger === "manual" ? job.clientRef : job.scheduledFor}`,
    db: { executeSql: (text: string, values?: unknown[]) => tx.raw.query(text, values as unknown[]) },
  });
}

export async function startRoutineWorker(handler: (job: RoutineRunJob) => Promise<void>, opts: { pollingIntervalSeconds?: number } = {}): Promise<void> {
  const boss = await getBoss();
  workerId = await boss.work<RoutineRunJob>(QUEUES.routineRun, { batchSize: 1, pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 5 }, async (jobs) => {
    for (const job of jobs) await handler(job.data);
  });
}

export async function stopRoutineWorker(): Promise<void> {
  if (!workerId) return;
  const boss = await getBoss();
  await boss.offWork(QUEUES.routineRun, { id: workerId, wait: true });
  workerId = undefined;
}
