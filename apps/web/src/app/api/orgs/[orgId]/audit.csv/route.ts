import { AppError, exportAuditCsv } from "@wos/core";
import { getSessionUserId } from "@/server/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const userId = await getSessionUserId(req.headers);
  if (!userId) return new Response("Sign in to continue", { status: 401 });
  const { orgId } = await params;
  try {
    const csv = await exportAuditCsv({ actorUserId: userId, orgId });
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.code === "FORBIDDEN" ? 403 : 404 });
    throw err;
  }
}
