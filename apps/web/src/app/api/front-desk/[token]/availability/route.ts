import { listAvailability } from "@wos/core";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const url = new URL(req.url);
  const from = new Date(url.searchParams.get("from") ?? Date.now());
  const to = new Date(url.searchParams.get("to") ?? Date.now() + 14 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return NextResponse.json({ error: "Invalid from/to" }, { status: 400 });
  }
  try {
    const data = await listAvailability(token, from, to);
    return NextResponse.json(data);
  } catch (err) {
    const code = (err as { code?: string }).code;
    const status = code === "NOT_FOUND" ? 404 : code === "RATE_LIMITED" ? 429 : 400;
    return NextResponse.json({ error: err instanceof Error ? err.message : "error" }, { status });
  }
}
