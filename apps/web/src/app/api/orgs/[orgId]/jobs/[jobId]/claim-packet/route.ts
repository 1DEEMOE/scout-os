import { exportClaimPacket } from "@wos/core";
import { orgContext } from "@/server/org-context";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ orgId: string; jobId: string }> }) {
  const { orgId, jobId } = await params;
  const { userId } = await orgContext(orgId);
  const { html, filename } = await exportClaimPacket({ actorUserId: userId, orgId, jobId });
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
