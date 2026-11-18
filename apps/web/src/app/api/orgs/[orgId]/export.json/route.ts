import { AppError, exportTenantData } from "@wos/core";
import { getSessionUserId } from "@/server/auth";

export const dynamic = "force-dynamic";

/** Full workspace data export (JSON). Owners/admins only; audited as privacy.export. */
export async function GET(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const userId = await getSessionUserId(req.headers);
  if (!userId) return new Response("Sign in to continue", { status: 401 });
  const { orgId } = await params;
  try {
    const bundle = await exportTenantData({ actorUserId: userId, orgId });
    const body = JSON.stringify(
      bundle,
      (_key, value: unknown) => (Buffer.isBuffer(value) ? `[binary ${value.length} bytes omitted]` : value),
      2,
    );
    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="workspace-export-${new Date().toISOString().slice(0, 10)}.json"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.code === "FORBIDDEN" ? 403 : 404 });
    throw err;
  }
}
