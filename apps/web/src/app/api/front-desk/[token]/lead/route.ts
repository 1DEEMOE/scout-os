import { publicClientAllowed, submitLeadForm } from "@wos/core";
import { NextResponse } from "next/server";
import { clientIp, publicErrorResponse, readJsonBody } from "@/server/public-api";

export const dynamic = "force-dynamic";

const str = (v: unknown, max: number) => (v == null ? undefined : String(v).slice(0, max));

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  // Public endpoint, no session cookie: outside AI agents (no Origin header)
  // are welcome; a browser driven by a third-party site is not.
  if (!publicClientAllowed(req)) return NextResponse.json({ error: "Cross-site request blocked" }, { status: 403 });
  const { token } = await params;
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  try {
    const result = await submitLeadForm({
      publicToken: token,
      name: str(body.name, 120) ?? "",
      email: str(body.email, 254) ?? "",
      phone: str(body.phone, 40),
      company: str(body.company, 120),
      message: str(body.message, 1000),
      website: str(body.website, 200),
      sourceIp: clientIp(req.headers),
    });
    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    return publicErrorResponse(err, "front-desk.lead");
  }
}
