/**
 * Lost routine-run recovery scanner (gaps-1).
 *
 * Finds active routines whose next_run_at is due, but neither a live pg-boss
 * job nor a routine_run row exists for that scheduled instant (e.g. after a
 * worker crash cleared the queue). Re-queues exactly once per
 * (routine, scheduled_for) via routine_recoveries UNIQUE, writes an audit
 * row, and leaves plan run caps to executeRoutineRun (consumeQuota).
 *
 * Cross-tenant listing needs DATABASE_URL_ADMIN (BYPASSRLS). Per-tenant
 * recovery works under ordinary withTenant.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  adminQuery,
  adminUrl,
  PGBOSS_SCHEMA,
  QUEUES,
  routineRecoveries,
  routineRuns,
  routines,
  withTenant,
  type Tx,
} from "@wos/db";
import { recordAudit } from "../audit";
import { MANAGERS, inOrg, requireRole } from "../org/access";
import { logger } from "../logger";
import { enqueueRoutineRun } from "./queue";

export type RecoveryReason = "missing_job" | "expired_job";

export interface DueRoutineRef {
  id: string;
  tenantId: string;
  nextRunAt: Date;
}

export interface RecoveryResult {
  scanned: number;
  recovered: number;
  skippedAlive: number;
  skippedAlreadyRun: number;
  skippedDuplicate: number;
  errors: number;
}

const emptyResult = (): RecoveryResult => ({
  scanned: 0,
  recovered: 0,
  skippedAlive: 0,
  skippedAlreadyRun: 0,
  skippedDuplicate: 0,
  errors: 0,
});

function singletonKey(routineId: string, scheduledForIso: string): string {
  return `${routineId}:schedule:${scheduledForIso}`;
}

function runKey(scheduledForIso: string): string {
  return `schedule:${scheduledForIso}`;
}

/** List due active routines across all tenants. Requires DATABASE_URL_ADMIN. */
export async function listDueRoutinesAdmin(asOf: Date = new Date()): Promise<DueRoutineRef[]> {
  const rows = await adminQuery<{ id: string; tenant_id: string; next_run_at: Date }>(
    `SELECT id, tenant_id, next_run_at
       FROM routines
      WHERE status = 'active'
        AND next_run_at IS NOT NULL
        AND next_run_at <= $1
      ORDER BY next_run_at ASC
      LIMIT 500`,
    [asOf],
  );
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, nextRunAt: new Date(r.next_run_at) }));
}

/** List due routines inside one tenant (ordinary RLS). */
export async function listDueRoutinesForTenant(tenantId: string, asOf: Date = new Date()): Promise<DueRoutineRef[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ id: routines.id, tenantId: routines.tenantId, nextRunAt: routines.nextRunAt })
      .from(routines)
      .where(and(eq(routines.status, "active"), sql`${routines.nextRunAt} IS NOT NULL AND ${routines.nextRunAt} <= ${asOf}`));
    return rows
      .filter((r): r is typeof r & { nextRunAt: Date } => r.nextRunAt != null)
      .map((r) => ({ id: r.id, tenantId: r.tenantId, nextRunAt: r.nextRunAt }));
  });
}

async function liveJobExists(tx: Tx, routineId: string, scheduledForIso: string): Promise<boolean> {
  const key = singletonKey(routineId, scheduledForIso);
  const r = await tx.raw.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM ${PGBOSS_SCHEMA}.job
      WHERE name = $1
        AND singleton_key = $2
        AND state::text = ANY(ARRAY['created','retry','active'])`,
    [QUEUES.routineRun, key],
  );
  return Number(r.rows[0]?.n ?? 0) > 0;
}

async function runAlreadyRecorded(tx: Tx, routineId: string, scheduledForIso: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: routineRuns.id })
    .from(routineRuns)
    .where(and(eq(routineRuns.routineId, routineId), eq(routineRuns.idempotencyKey, runKey(scheduledForIso))))
    .limit(1);
  return !!row;
}

/**
 * Attempt to recover one due routine. Idempotent: a second call for the same
 * (routine, scheduled_for) inserts nothing and returns duplicate.
 */
export async function recoverOneRoutine(
  ref: DueRoutineRef,
  opts: { reason?: RecoveryReason; now?: Date } = {},
): Promise<"recovered" | "alive" | "already_run" | "duplicate" | "stale"> {
  const reason = opts.reason ?? "missing_job";
  const scheduledForIso = ref.nextRunAt.toISOString();

  return withTenant(ref.tenantId, async (tx) => {
    const [r] = await tx.select().from(routines).where(eq(routines.id, ref.id)).for("update");
    if (!r || r.status !== "active" || !r.nextRunAt || r.nextRunAt.getTime() !== ref.nextRunAt.getTime()) {
      return "stale";
    }
    if (await runAlreadyRecorded(tx, r.id, scheduledForIso)) return "already_run";
    if (await liveJobExists(tx, r.id, scheduledForIso)) return "alive";

    const inserted = await tx
      .insert(routineRecoveries)
      .values({
        tenantId: r.tenantId,
        routineId: r.id,
        scheduledFor: r.nextRunAt,
        reason,
        recoveredAt: opts.now ?? new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: routineRecoveries.id });
    if (!inserted[0]) return "duplicate";

    await enqueueRoutineRun(
      tx,
      { tenantId: r.tenantId, routineId: r.id, scheduledFor: scheduledForIso, trigger: "schedule" },
      // Due now: start immediately (startAfter omitted).
    );
    // Audit: ids and reason only — never briefing contents or PII.
    await recordAudit(tx, {
      tenantId: r.tenantId,
      actorType: "system",
      actorId: "routine.reconciler",
      action: "routine.recover",
      target: `routine:${r.id}`,
      tier: 0,
      outcome: "success",
      metadata: {
        recoveryId: inserted[0].id,
        scheduledFor: scheduledForIso,
        reason,
      },
    });
    logger.info(
      { tenantId: r.tenantId, routineId: r.id, recoveryId: inserted[0].id, reason },
      "routine run recovered",
    );
    return "recovered";
  });
}

/** Recover every due routine in the given list. */
export async function recoverDueRoutines(refs: DueRoutineRef[], opts: { now?: Date } = {}): Promise<RecoveryResult> {
  const out = emptyResult();
  out.scanned = refs.length;
  for (const ref of refs) {
    try {
      const r = await recoverOneRoutine(ref, opts);
      if (r === "recovered") out.recovered += 1;
      else if (r === "alive") out.skippedAlive += 1;
      else if (r === "already_run") out.skippedAlreadyRun += 1;
      else if (r === "duplicate") out.skippedDuplicate += 1;
      // stale: counted in scanned only
    } catch (err) {
      out.errors += 1;
      logger.error({ err, tenantId: ref.tenantId, routineId: ref.id }, "routine recovery failed");
    }
  }
  return out;
}

/** Platform scan: list due routines via admin URL, then recover. No-op if admin URL unset. */
export async function recoverLostRoutineRuns(opts: { now?: Date } = {}): Promise<RecoveryResult & { disabled?: boolean }> {
  if (!adminUrl()) {
    logger.warn("routine reconciler disabled: DATABASE_URL_ADMIN is not set");
    return { ...emptyResult(), disabled: true };
  }
  const asOf = opts.now ?? new Date();
  const due = await listDueRoutinesAdmin(asOf);
  return recoverDueRoutines(due, opts);
}

/** Per-tenant scan (no admin URL required). */
export async function recoverLostRoutinesForTenant(
  tenantId: string,
  opts: { now?: Date } = {},
): Promise<RecoveryResult> {
  const asOf = opts.now ?? new Date();
  const due = await listDueRoutinesForTenant(tenantId, asOf);
  return recoverDueRoutines(due, opts);
}


/** Manager-triggered per-tenant recovery (UI / tRPC). */
export async function recoverLostRoutinesAsManager(input: {
  actorUserId: string;
  orgId: string;
  now?: Date;
}): Promise<RecoveryResult> {
  await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "routine.recover");
  });
  return recoverLostRoutinesForTenant(input.orgId, { now: input.now });
}
