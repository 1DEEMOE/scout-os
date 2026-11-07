import { getAuthPool } from "@wos/db";
import { integrations } from "@wos/core";

export const dynamic = "force-dynamic";

/**
 * Liveness/readiness for load balancers and uptime checks. Unauthenticated by
 * design; it reveals only "up/down", never data. 503 when the database is
 * unreachable so orchestrators can stop routing traffic.
 */
export async function GET() {
  try {
    await getAuthPool().query("SELECT 1");
    const breakers = integrations.snapshot();
    return Response.json({ ok: true, degraded: breakers.filter((b) => b.state === "open").map((b) => b.name) });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
