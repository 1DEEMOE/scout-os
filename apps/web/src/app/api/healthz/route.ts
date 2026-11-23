import { getAuthPool, PGBOSS_SCHEMA } from "@wos/db";
import { integrations } from "@wos/core";

export const dynamic = "force-dynamic";

/**
 * Liveness/readiness for load balancers and uptime checks. Unauthenticated by
 * design; it reveals only aggregate up/down signals, never tenant data:
 * - 503 when the database is unreachable so orchestrators stop routing traffic.
 * - `degraded`: integrations whose circuit breaker is open in THIS process.
 *   Durable breaker rows (0022) are per-tenant and deliberately not exposed on
 *   an unauthenticated endpoint; managers see them in Recovery.
 * - `queueBacklog`: queued + retrying jobs across the shared pg-boss schema.
 *   A growing backlog is the symptom users feel (approvals not expiring,
 *   tasks not running) and is safe to expose as a count.
 */
export async function GET() {
  try {
    const pool = getAuthPool();
    await pool.query("SELECT 1");
    const backlog = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${PGBOSS_SCHEMA}.job WHERE state IN ('created', 'retry')`,
    );
    const breakers = integrations.snapshot();
    return Response.json({
      ok: true,
      degraded: breakers.filter((b) => b.state === "open").map((b) => b.name),
      queueBacklog: Number(backlog.rows[0]?.n ?? 0),
    });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
