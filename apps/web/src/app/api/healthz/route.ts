import { getAuthPool } from "@wos/db";

export const dynamic = "force-dynamic";

/**
 * Liveness/readiness for load balancers and uptime checks. Unauthenticated by
 * design; it reveals only "up/down", never data. 503 when the database is
 * unreachable so orchestrators can stop routing traffic.
 */
export async function GET() {
  try {
    await getAuthPool().query("SELECT 1");
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
