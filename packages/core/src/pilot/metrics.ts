import { and, eq, sql } from "drizzle-orm";
import { memoryRecords, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { ANY_ROLE, inOrg, requireRole } from "../org/access";

const SCOPE = "pilot:metrics";
/** An estimate the screen labels as an estimate. Not a timesheet. */
const MINUTES_PER_BRIEFING = 6;

interface Stored {
  setupStartedAt: string | null;
  setupFinishedAt: string | null;
  firstReplyApprovedAt: string | null;
  bookingsRecovered: number;
  mock: true;
}

export interface PilotMetrics {
  setupStartedAt: string | null;
  setupFinishedAt: string | null;
  /** Seconds from the first industry choice to setup finish. Null until both exist. */
  setupSeconds: number | null;
  firstReplyApprovedAt: string | null;
  /** Seconds from setup start until the owner approved a first-reply template. Null until then. */
  firstReplySeconds: number | null;
  /** Missed or late-cancelled visits that were booked again. Starts at zero. */
  bookingsRecovered: number;
  briefingRuns: number;
  /** briefingRuns × 6. Shown as an estimate. */
  hoursSavedMinutes: number;
  mock: true;
}

function blank(): Stored {
  return { setupStartedAt: null, setupFinishedAt: null, firstReplyApprovedAt: null, bookingsRecovered: 0, mock: true };
}

async function readStored(tx: Tx): Promise<Stored> {
  const [row] = await tx.select({ content: memoryRecords.content }).from(memoryRecords).where(and(eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, SCOPE)));
  if (!row) return blank();
  try {
    const parsed = JSON.parse(row.content) as Partial<Stored>;
    return { ...blank(), ...parsed, mock: true, bookingsRecovered: Number(parsed.bookingsRecovered ?? 0) };
  } catch {
    return blank();
  }
}

async function writeStored(tx: Tx, tenantId: string, userId: string, value: Stored): Promise<void> {
  const content = JSON.stringify(value);
  await tx.delete(memoryRecords).where(and(eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, SCOPE)));
  await tx.insert(memoryRecords).values({ tenantId, layer: "org", scopeRef: SCOPE, content, trust: "user", createdByUser: userId });
}

async function briefingRuns(tx: Tx, orgId: string): Promise<number> {
  const res = await tx.execute(sql`
    SELECT count(*)::int AS n
    FROM routine_runs rr
    INNER JOIN routines r ON r.id = rr.routine_id AND r.tenant_id = rr.tenant_id
    WHERE rr.tenant_id = ${orgId}::uuid AND rr.status = 'succeeded' AND r.kind = 'morning_briefing'
  `);
  return Number(res.rows[0]?.n ?? 0);
}

function secondsBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const n = Math.round((Date.parse(end) - Date.parse(start)) / 1000);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function readPilotMetrics(input: { actorUserId: string; orgId: string }): Promise<PilotMetrics> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "pilot.read");
    const stored = await readStored(tx);
    const runs = await briefingRuns(tx, input.orgId);
    return {
      ...stored,
      setupSeconds: secondsBetween(stored.setupStartedAt, stored.setupFinishedAt),
      firstReplySeconds: secondsBetween(stored.setupStartedAt, stored.firstReplyApprovedAt),
      briefingRuns: runs,
      hoursSavedMinutes: runs * MINUTES_PER_BRIEFING,
      mock: true,
    };
  });
}

export async function noteSetupStarted(tx: Tx, tenantId: string, userId: string): Promise<void> {
  const cur = await readStored(tx);
  if (cur.setupStartedAt) return;
  await writeStored(tx, tenantId, userId, { ...cur, setupStartedAt: new Date().toISOString() });
  await recordAudit(tx, { tenantId, actorType: "user", actorId: userId, action: "pilot.setup.started", target: `organization:${tenantId}`, tier: 0, outcome: "success" });
}

export async function noteSetupFinished(tx: Tx, tenantId: string, userId: string, approveTemplates: boolean): Promise<void> {
  const cur = await readStored(tx);
  const now = new Date().toISOString();
  const next: Stored = { ...cur, setupFinishedAt: cur.setupFinishedAt ?? now, setupStartedAt: cur.setupStartedAt ?? now };
  if (approveTemplates && !next.firstReplyApprovedAt) next.firstReplyApprovedAt = now;
  await writeStored(tx, tenantId, userId, next);
  await recordAudit(tx, { tenantId, actorType: "user", actorId: userId, action: "pilot.setup.finished", target: `organization:${tenantId}`, tier: 1, outcome: "success", metadata: { approveTemplates } });
}

/** A missed or late-cancelled visit was booked again. Counts one recovery. */
export async function noteBookingRecovered(tx: Tx, tenantId: string, userId: string, visitId: string): Promise<void> {
  const cur = await readStored(tx);
  await writeStored(tx, tenantId, userId, { ...cur, bookingsRecovered: cur.bookingsRecovered + 1 });
  await recordAudit(tx, { tenantId, actorType: "user", actorId: userId, action: "pilot.booking.recovered", target: `visit:${visitId}`, tier: 1, outcome: "success" });
}
