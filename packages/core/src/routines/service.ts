import { and, desc, eq, sql } from "drizzle-orm";
import { aiAnswerChecks, routineRuns, routines, type AgentKind, withTenant, withTenantOutOfBand, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { logger } from "../logger";
import { ANY_ROLE, MANAGERS, inOrg, requireRole } from "../org/access";
import { agentsPaused } from "../org/pause";
import { consumeQuota, entitlementsIn } from "../billing/plans";
import { insertTask } from "../engine/tasks";
import { buildMorningBriefing, MissingSourceError, type Briefing, type SourceReader } from "./briefing";
import { aiAnswersPeriod } from "../ai-answers/service";
import { getAiAnswersProvider } from "../ai-answers/provider";
import { describeSchedule, nextRunAfter, validateSchedule, type Schedule } from "./schedule";
import { enqueueRoutineRun, type RoutineRunJob } from "./queue";

/** Routines may act on their own at tier 0–1 only. Everything above goes through approvals. */
export const ROUTINE_MAX_AUTONOMOUS_TIER = 1;

export type RoutineRow = typeof routines.$inferSelect;
export type RoutineRunRow = typeof routineRuns.$inferSelect;

export interface RoutineView extends RoutineRow {
  scheduleText: string;
  lastRun: Pick<RoutineRunRow, "id" | "status" | "skipReason" | "error" | "startedAt" | "finishedAt"> | null;
}

function schedOf(r: Pick<RoutineRow, "hour" | "minute" | "daysOfWeek" | "timezone">): Schedule {
  return { hour: r.hour, minute: r.minute, daysOfWeek: r.daysOfWeek, timezone: r.timezone };
}

async function activeCount(tx: Tx): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(routines).where(eq(routines.status, "active"));
  return r?.n ?? 0;
}

async function requireRoutineSlot(tx: Tx, orgId: string, actorUserId: string, action: string): Promise<void> {
  const ent = await entitlementsIn(tx, orgId);
  const limit = ent.plan.limits.routines;
  if (limit !== null && (await activeCount(tx)) >= limit) {
    await withTenantOutOfBand(orgId, (t) => recordAudit(t, { tenantId: orgId, actorType: "user", actorId: actorUserId, action, outcome: "denied", tier: 1, metadata: { reason: "quota_exceeded", metric: "routines", limit } }));
    throw new AppError("QUOTA_EXCEEDED", `The ${ent.plan.label} plan includes ${limit} active routine${limit === 1 ? "" : "s"}. Pause one or upgrade.`, { metric: "routines", limit });
  }
}

export interface CreateRoutineInput {
  actorUserId: string;
  orgId: string;
  kind: "morning_briefing";
  name: string;
  hour: number;
  minute: number;
  daysOfWeek: number[];
  timezone: string;
  now?: Date;
}

export async function createRoutine(input: CreateRoutineInput): Promise<RoutineRow> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new AppError("VALIDATION", "Give the routine a name");
  const sched: Schedule = { hour: input.hour, minute: input.minute, daysOfWeek: [...new Set(input.daysOfWeek)].sort(), timezone: input.timezone };
  const err = validateSchedule(sched);
  if (err) throw new AppError("VALIDATION", err);
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "routine.create");
    await requireRoutineSlot(tx, input.orgId, input.actorUserId, "routine.create");
    const next = nextRunAfter(sched, input.now ?? new Date());
    const [row] = await tx
      .insert(routines)
      .values({ tenantId: input.orgId, kind: input.kind, name, agentKind: "coordinator", ...sched, maxTier: 0, status: "active", nextRunAt: next, createdBy: input.actorUserId, updatedBy: input.actorUserId })
      .returning();
    await enqueueRoutineRun(tx, { tenantId: input.orgId, routineId: row!.id, scheduledFor: next.toISOString(), trigger: "schedule" }, { startAfter: next });
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "routine.create", target: `routine:${row!.id}`, tier: 1, outcome: "success", metadata: { kind: input.kind, schedule: describeSchedule(sched) } });
    return row!;
  });
}

export async function setRoutinePaused(input: { actorUserId: string; orgId: string; routineId: string; paused: boolean; now?: Date }): Promise<RoutineRow> {
  return inOrg(input.orgId, async (tx) => {
    const action = input.paused ? "routine.pause" : "routine.resume";
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, action);
    const [r] = await tx.select().from(routines).where(eq(routines.id, input.routineId)).for("update");
    if (!r) throw new AppError("NOT_FOUND", "Routine not found");
    if ((r.status === "paused") === input.paused) throw new AppError("CONFLICT", input.paused ? "Routine is already paused" : "Routine isn't paused");
    let next: Date | null = null;
    if (!input.paused) {
      await requireRoutineSlot(tx, input.orgId, input.actorUserId, action);
      next = nextRunAfter(schedOf(r), input.now ?? new Date());
    }
    const [row] = await tx
      .update(routines)
      .set({ status: input.paused ? "paused" : "active", nextRunAt: next, updatedBy: input.actorUserId, updatedAt: new Date() })
      .where(eq(routines.id, r.id))
      .returning();
    if (next) await enqueueRoutineRun(tx, { tenantId: input.orgId, routineId: r.id, scheduledFor: next.toISOString(), trigger: "schedule" }, { startAfter: next });
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action, target: `routine:${r.id}`, tier: 1, outcome: "success" });
    return row!;
  });
}

/** "Run now". Queued, not run inline, so it goes through the same idempotent path as the schedule. */
export async function runRoutineNow(input: { actorUserId: string; orgId: string; routineId: string; clientRef: string }): Promise<{ queued: true }> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(input.clientRef)) throw new AppError("VALIDATION", "Invalid request reference");
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "routine.run_now");
    const [r] = await tx.select().from(routines).where(eq(routines.id, input.routineId));
    if (!r) throw new AppError("NOT_FOUND", "Routine not found");
    if (await agentsPaused(tx, input.orgId)) throw new AppError("CONFLICT", "Agents are paused for this organization. Resume them in Settings to run routines.");
    await enqueueRoutineRun(tx, { tenantId: input.orgId, routineId: r.id, scheduledFor: new Date().toISOString(), trigger: "manual", clientRef: input.clientRef });
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "routine.run_now", target: `routine:${r.id}`, tier: 1, outcome: "success" });
    return { queued: true };
  });
}

export async function listRoutines(input: { actorUserId: string; orgId: string }): Promise<RoutineView[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "routine.list");
    const rows = await tx.select().from(routines).orderBy(desc(routines.createdAt));
    const out: RoutineView[] = [];
    for (const r of rows) {
      const [last] = await tx
        .select({ id: routineRuns.id, status: routineRuns.status, skipReason: routineRuns.skipReason, error: routineRuns.error, startedAt: routineRuns.startedAt, finishedAt: routineRuns.finishedAt })
        .from(routineRuns)
        .where(eq(routineRuns.routineId, r.id))
        .orderBy(desc(routineRuns.startedAt))
        .limit(1);
      out.push({ ...r, scheduleText: describeSchedule(schedOf(r)), lastRun: last ?? null });
    }
    return out;
  });
}

export async function getRoutine(input: { actorUserId: string; orgId: string; routineId: string }): Promise<{ routine: RoutineView; runs: RoutineRunRow[] }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "routine.read");
    const [r] = await tx.select().from(routines).where(eq(routines.id, input.routineId));
    if (!r) throw new AppError("NOT_FOUND", "Routine not found");
    const runs = await tx.select().from(routineRuns).where(eq(routineRuns.routineId, r.id)).orderBy(desc(routineRuns.startedAt)).limit(30);
    const last = runs[0];
    return { routine: { ...r, scheduleText: describeSchedule(schedOf(r)), lastRun: last ? { id: last.id, status: last.status, skipReason: last.skipReason, error: last.error, startedAt: last.startedAt, finishedAt: last.finishedAt } : null }, runs };
  });
}

/** The latest successful briefing across the org's routines, for the briefing view. */
export async function latestBriefing(input: { actorUserId: string; orgId: string }): Promise<{ run: RoutineRunRow; routineName: string } | null> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "routine.briefing.read");
    const [row] = await tx
      .select({ run: routineRuns, name: routines.name })
      .from(routineRuns)
      .innerJoin(routines, and(eq(routines.tenantId, routineRuns.tenantId), eq(routines.id, routineRuns.routineId)))
      .where(and(eq(routineRuns.status, "succeeded"), eq(routines.kind, "morning_briefing")))
      .orderBy(desc(routineRuns.finishedAt))
      .limit(1);
    return row ? { run: row.run, routineName: row.name } : null;
  });
}

// ---------- tier enforcement ----------

export interface RoutineStep {
  tool: string;
  args: unknown;
  /** Tier of the tool as registered. The engine re-derives it; this is never trusted to loosen policy. */
  tier: number;
  /** The AI employee whose tool this is. The Coordinator hands higher-tier work to it, through approvals. */
  agentKind?: AgentKind;
}

/**
 * Decides what a routine may do with a step. Steps at or below both the
 * routine's max tier and ROUTINE_MAX_AUTONOMOUS_TIER run inline. Anything
 * higher is NOT executed: it becomes an ordinary task with that exact step,
 * so the engine's unchanged policy creates the approval request (tier 2–3: one
 * approval; tier 4: two confirmations from different owners).
 */
export async function routeRoutineStep(
  tx: Tx,
  routine: Pick<RoutineRow, "id" | "tenantId" | "maxTier" | "createdBy" | "agentKind" | "name">,
  step: RoutineStep,
): Promise<{ mode: "inline" } | { mode: "approval_task"; taskId: string }> {
  const allowed = Math.min(routine.maxTier, ROUTINE_MAX_AUTONOMOUS_TIER);
  if (Number.isInteger(step.tier) && step.tier >= 0 && step.tier <= allowed) return { mode: "inline" };
  const { taskId } = await insertTask(tx, {
    orgId: routine.tenantId,
    actorUserId: routine.createdBy,
    intent: `Routine "${routine.name}" wants to run ${step.tool}`,
    title: `Routine: ${step.tool}`,
    input: { agentKind: step.agentKind ?? "orchestrator", routineId: routine.id, coordinator: routine.agentKind },
    plan: { direct: [{ tool: step.tool, args: step.args }] },
    auditMetadata: { routineId: routine.id, requestedTier: step.tier },
  });
  return { mode: "approval_task", taskId };
}

// ---------- the run ----------

export type RunOutcome =
  | { status: "stale" | "duplicate" }
  | { status: "skipped"; reason: "agents_paused" | "quota_exceeded" | "routine_paused"; runId: string }
  | { status: "failed"; runId: string; error: string }
  | { status: "succeeded"; runId: string };

export interface RunDeps {
  now?: () => Date;
  /** Tests only: substitute briefing source readers. */
  readers?: Record<string, SourceReader>;
  orgBase?: (orgId: string) => string;
}

/**
 * Executes one routine run job. Idempotent: the (routine, idempotency key)
 * unique index means a redelivered job, a double click, or two workers can
 * only ever produce one run row. Stale jobs (routine paused, rescheduled or
 * already advanced) do nothing.
 */
export async function executeRoutineRun(job: RoutineRunJob, deps: RunDeps = {}): Promise<RunOutcome> {
  const now = deps.now ?? (() => new Date());
  const key = job.trigger === "manual" ? `manual:${job.clientRef ?? ""}` : `schedule:${job.scheduledFor}`;
  if (job.trigger === "manual" && !job.clientRef) return { status: "stale" };

  const outcome = await withTenant(job.tenantId, async (tx): Promise<RunOutcome> => {
    const [r] = await tx.select().from(routines).where(eq(routines.id, job.routineId)).for("update");
    if (!r) return { status: "stale" };
    const scheduled = new Date(job.scheduledFor);
    if (job.trigger === "schedule" && (r.status !== "active" || r.nextRunAt?.getTime() !== scheduled.getTime())) return { status: "stale" };

    const inserted = await tx
      .insert(routineRuns)
      .values({ tenantId: r.tenantId, routineId: r.id, trigger: job.trigger, idempotencyKey: key, scheduledFor: scheduled, status: "running" })
      .onConflictDoNothing()
      .returning({ id: routineRuns.id });
    const runId = inserted[0]?.id;
    if (!runId) return { status: "duplicate" };

    const at = now();
    // Advance the schedule first, whatever this run's outcome: a failed or skipped morning doesn't stop tomorrow's.
    if (job.trigger === "schedule") {
      const next = nextRunAfter(schedOf(r), new Date(Math.max(at.getTime(), scheduled.getTime())));
      await tx.update(routines).set({ nextRunAt: next, lastRunAt: at, updatedAt: at }).where(eq(routines.id, r.id));
      await enqueueRoutineRun(tx, { tenantId: r.tenantId, routineId: r.id, scheduledFor: next.toISOString(), trigger: "schedule" }, { startAfter: next });
    } else {
      await tx.update(routines).set({ lastRunAt: at }).where(eq(routines.id, r.id));
    }

    const finish = async (set: Partial<typeof routineRuns.$inferInsert>) => {
      await tx.update(routineRuns).set({ ...set, finishedAt: now() }).where(eq(routineRuns.id, runId));
    };
    const audit = (outcome: "success" | "denied" | "error", metadata: Record<string, unknown>) =>
      recordAudit(tx, { tenantId: r.tenantId, actorType: "agent", actorId: `routine:${r.id}`, action: "routine.run", target: `routine_run:${runId}`, tier: 0, outcome, idempotencyKey: key, metadata: { trigger: job.trigger, ...metadata } });

    if (r.status !== "active" && job.trigger === "manual") {
      await finish({ status: "skipped", skipReason: "routine_paused" });
      await audit("denied", { reason: "routine_paused" });
      return { status: "skipped", reason: "routine_paused", runId };
    }
    if (await agentsPaused(tx, r.tenantId)) {
      await finish({ status: "skipped", skipReason: "agents_paused" });
      await audit("denied", { reason: "agents_paused" });
      return { status: "skipped", reason: "agents_paused", runId };
    }
    try {
      await tx.raw.query("SAVEPOINT routine_quota");
      await consumeQuota(tx, r.tenantId, "routine.runs", 1);
      await tx.raw.query("RELEASE SAVEPOINT routine_quota");
    } catch (err) {
      await tx.raw.query("ROLLBACK TO SAVEPOINT routine_quota");
      if (!(err instanceof AppError) || err.code !== "QUOTA_EXCEEDED") throw err;
      await finish({ status: "skipped", skipReason: "quota_exceeded", error: err.message });
      await audit("denied", { reason: "quota_exceeded" });
      return { status: "skipped", reason: "quota_exceeded", runId };
    }

    // The briefing is all tier-0 reads; declare it so tier enforcement covers it like any other step.
    const route = await routeRoutineStep(tx, r, { tool: "routine.morning_briefing", args: {}, tier: 0 });
    if (route.mode !== "inline") throw new Error("briefing must run inline"); // unreachable: tier 0

    const sourcesUsed: { source: string; rows: number; asOf: string }[] = [];
    let briefing: Briefing;
    try {
      const res = await buildMorningBriefing(tx, r.tenantId, { now: at, timezone: r.timezone, orgBase: (deps.orgBase ?? ((id) => `/orgs/${id}`))(r.tenantId), ...(deps.readers ? { readers: deps.readers } : {}) });
      briefing = res.briefing;
      sourcesUsed.push(...res.sources);
    } catch (err) {
      if (!(err instanceof MissingSourceError)) throw err;
      // Fail loudly: record which source broke; no partial briefing is stored.
      const message = `Briefing not produced. ${err.message}`.slice(0, 1000);
      await finish({ status: "failed", error: message, sources: err.readSoFar.length ? err.readSoFar : [{ source: err.source, rows: -1, asOf: at.toISOString() }] });
      await audit("error", { reason: "missing_source", source: err.source });
      logger.error({ tenantId: r.tenantId, routineId: r.id, runId, source: err.source }, "routine run failed: source unavailable");
      return { status: "failed", runId, error: message };
    }
    // Monthly AI-answers step (tier 0): uses prior ZIP if we have one; mock provider only.
    try {
      await tx.raw.query("SAVEPOINT ai_answers_step");
      const [prior] = await tx.select().from(aiAnswerChecks).orderBy(desc(aiAnswerChecks.period)).limit(1);
      if (prior?.zip) {
        const period = aiAnswersPeriod(at);
        if (prior.period !== period) {
          // runAiAnswersCheck opens its own inOrg txn — call provider inline instead.
          const result = await getAiAnswersProvider().check({ trade: prior.trade, zip: prior.zip });
          const trendDelta = result.score - prior.score;
          await tx.insert(aiAnswerChecks).values({
            tenantId: r.tenantId,
            period,
            trade: prior.trade,
            zip: prior.zip,
            recommended: result.recommended,
            score: result.score,
            provider: result.provider,
            suggestions: [...result.suggestions],
            trendDelta,
            routineRunId: runId,
          });
          sourcesUsed.push({ source: "ai_answers_monthly", rows: 1, asOf: at.toISOString() });
          // Refresh briefing section if present
          const idx = briefing.sections.findIndex((s) => s.key === "ai_visibility");
          const items = [
            {
              label: result.recommended ? `Recommended for ${prior.trade} in ${prior.zip}` : `Not clearly recommended for ${prior.trade} in ${prior.zip}`,
              detail: `Score ${result.score}/100 · trend ${trendDelta >= 0 ? "+" : ""}${trendDelta} · ${period}`,
            },
            ...result.suggestions.map((s) => ({ label: s })),
          ];
          const section = { key: "ai_visibility" as const, title: "AI answers · are you recommended?", status: "ok" as const, count: 1, items, sources: ["ai_answers_monthly"] };
          if (idx >= 0) briefing.sections[idx] = section;
          else briefing.sections.push(section);
        }
      }
      await tx.raw.query("RELEASE SAVEPOINT ai_answers_step");
    } catch {
      await tx.raw.query("ROLLBACK TO SAVEPOINT ai_answers_step").catch(() => undefined);
    }

    await finish({ status: "succeeded", output: briefing, sources: sourcesUsed });
    await audit("success", { sources: sourcesUsed.map((s) => s.source) });
    // Counts only; briefing contents never go to logs.
    logger.info({ tenantId: r.tenantId, routineId: r.id, runId, sections: briefing.sections.length }, "routine run succeeded");
    return { status: "succeeded", runId };
  });
  return outcome;
}
