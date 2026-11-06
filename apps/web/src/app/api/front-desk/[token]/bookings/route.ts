import { requestBooking, sameOrigin } from "@wos/core";
import { NextResponse } from "next/server";
import { clientIp, publicErrorResponse, readJsonBody } from "@/server/public-api";

export const dynamic = "force-dynamic";

const str = (v: unknown, max: number) => (v == null ? undefined : String(v).slice(0, max));

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Cross-site request blocked" }, { status: 403 });
  const { token } = await params;
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  try {
    const result = await requestBooking({
      publicToken: token,
      slotId: str(body.slotId, 64) ?? "",
      requesterKind: body.requesterKind === "ai_agent" ? "ai_agent" : "person",
      agentName: str(body.agentName, 200),
      agentProvider: str(body.agentProvider, 200),
      disclosureAck: body.disclosureAck === true,
      customerName: str(body.customerName, 200) ?? "",
      customerEmail: str(body.customerEmail, 254) ?? "",
      customerPhone: str(body.customerPhone, 40),
      notes: str(body.notes, 2000),
      clientRef: str(body.clientRef, 100),
      sourceIp: clientIp(req.headers),
    });
    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    return publicErrorResponse(err, "front-desk.bookings");
  }
}
