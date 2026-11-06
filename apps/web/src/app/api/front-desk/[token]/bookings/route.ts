import { requestBooking } from "@wos/core";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const sourceIp = forwarded || req.headers.get("x-real-ip") || "0.0.0.0";
  try {
    const result = await requestBooking({
      publicToken: token,
      slotId: String(body.slotId ?? ""),
      requesterKind: body.requesterKind === "ai_agent" ? "ai_agent" : "person",
      agentName: body.agentName != null ? String(body.agentName) : undefined,
      agentProvider: body.agentProvider != null ? String(body.agentProvider) : undefined,
      disclosureAck: Boolean(body.disclosureAck),
      customerName: String(body.customerName ?? ""),
      customerEmail: String(body.customerEmail ?? ""),
      customerPhone: body.customerPhone != null ? String(body.customerPhone) : undefined,
      notes: body.notes != null ? String(body.notes) : undefined,
      clientRef: body.clientRef != null ? String(body.clientRef) : undefined,
      sourceIp,
    });
    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    const code = (err as { code?: string }).code;
    const status =
      code === "NOT_FOUND" ? 404 : code === "RATE_LIMITED" ? 429 : code === "CONFLICT" ? 409 : code === "VALIDATION" ? 400 : 400;
    return NextResponse.json({ error: err instanceof Error ? err.message : "error", code }, { status });
  }
}
