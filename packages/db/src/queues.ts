/** Job queues. Created by the migration step, used by the app and workers. */
export const QUEUES = {
  taskRun: "task.run",
  routineRun: "routine.run",
  inboxSync: "inbox.sync",
} as const;

export const PGBOSS_SCHEMA = "pgboss";
