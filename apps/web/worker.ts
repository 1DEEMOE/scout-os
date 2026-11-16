// Task worker: a separate process from the web server.
// Run with: pnpm --filter @wos/web worker
// The worker runs the queue's maintenance loop, which retries jobs held by a
// worker that crashed. The web server doesn't need it.
process.env.WOS_QUEUE_SUPERVISE ??= "1";

import { executeRoutineRun, handleTaskRunJob, initOtel, logger, recoverLostRoutineRuns, shutdownOtel, startInboxSyncWorker, startRoutineWorker, startTaskWorker, stopBoss, stopInboxSyncWorker, stopRoutineWorker, stopTaskWorker, syncStormReportsAllTenants } from "@wos/core";
import { ensureEngine } from "./src/server/engine";

await initOtel("ascend-worker");
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

// Automatic NOAA SPC storm-report feed: every WOS_STORM_SYNC_SECONDS
// (default 6h, minimum 15 min), for orgs with a reviewed Scout profile.
// Cross-tenant listing needs DATABASE_URL_ADMIN, same as the reconciler.
let stormTimer: ReturnType<typeof setInterval> | undefined;
if (process.env.DATABASE_URL_ADMIN) {
  const secs = Math.max(900, Number(process.env.WOS_STORM_SYNC_SECONDS ?? "21600"));
  if (!Number.isFinite(secs)) throw new Error("WOS_STORM_SYNC_SECONDS must be a number");
  const tick = async () => {
    try {
      const r = await syncStormReportsAllTenants();
      if (r.ingested || r.failed) logger.info({ ...r }, "storm sync pass");
    } catch (err) {
      logger.error({ err }, "storm sync pass failed");
    }
  };
  void tick();
  stormTimer = setInterval(() => void tick(), secs * 1000);
  logger.info({ intervalSeconds: secs }, "storm sync scheduled");
} else {
  logger.warn("storm sync idle: DATABASE_URL_ADMIN not set");
}


async function shutdown(signal: string) {
  logger.info({ signal }, "task worker stopping");
  await stopTaskWorker();
  if (reconcileTimer) clearInterval(reconcileTimer);
  if (stormTimer) clearInterval(stormTimer);
  await stopRoutineWorker();
  await stopInboxSyncWorker();
  await stopBoss();
  await shutdownOtel();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
