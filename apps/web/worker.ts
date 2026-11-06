// Task worker: a separate process from the web server.
// Run with: pnpm --filter @wos/web worker
// The worker runs the queue's maintenance loop, which retries jobs held by a
// worker that crashed. The web server doesn't need it.
process.env.WOS_QUEUE_SUPERVISE ??= "1";

import { executeRoutineRun, handleTaskRunJob, initOtel, logger, recoverLostRoutineRuns, shutdownOtel, startInboxSyncWorker, startRoutineWorker, startTaskWorker, stopBoss, stopInboxSyncWorker, stopRoutineWorker, stopTaskWorker } from "@wos/core";
import { ensureEngine } from "./src/server/engine";

await initOtel("scout-os-worker");
ensureEngine();
await startTaskWorker(handleTaskRunJob);
await startInboxSyncWorker();
await startRoutineWorker(async (job) => {
  const out = await executeRoutineRun(job);
  logger.info({ tenantId: job.tenantId, routineId: job.routineId, trigger: job.trigger, status: out.status }, "routine job handled");
});
logger.info("task worker started (routine worker too)");

// Lost-run recovery: every 60s when DATABASE_URL_ADMIN is set. Idempotent.
let reconcileTimer: ReturnType<typeof setInterval> | undefined;
if (process.env.DATABASE_URL_ADMIN) {
  const tick = async () => {
    try {
      const r = await recoverLostRoutineRuns();
      if (r.recovered || r.errors) logger.info({ ...r }, "routine reconciler pass");
    } catch (err) {
      logger.error({ err }, "routine reconciler failed");
    }
  };
  void tick();
  reconcileTimer = setInterval(() => void tick(), 60_000);
} else {
  logger.warn("routine reconciler idle: DATABASE_URL_ADMIN not set");
}


async function shutdown(signal: string) {
  logger.info({ signal }, "task worker stopping");
  await stopTaskWorker();
  if (reconcileTimer) clearInterval(reconcileTimer);
  await stopRoutineWorker();
  await stopInboxSyncWorker();
  await stopBoss();
  await shutdownOtel();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
