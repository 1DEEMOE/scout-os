import { exportClaimPacket, exportClaimPacketPdf } from "@wos/core";
import { orgContext } from "@/server/org-context";

export const dynamic = "force-dynamic";

/** Claim packet download: ?format=pdf (default for people) or the HTML version. */
export async function GET(req: Request, { params }: { params: Promise<{ orgId: string; jobId: string }> }) {
  const { orgId, jobId } = await params;
  const { userId } = await orgContext(orgId);
  if (new URL(req.url).searchParams.get("format") === "pdf") {
    const { pdf, filename, fingerprint } = await exportClaimPacketPdf({ actorUserId: userId, orgId, jobId });
    return new Response(Buffer.from(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filename}"`,
        "x-packet-fingerprint": fingerprint,
        "cache-control": "no-store",
      },
    });
  }
  const { html, filename } = await exportClaimPacket({ actorUserId: userId, orgId, jobId });
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
