import { listAvailability } from "@wos/core";
import { NextResponse } from "next/server";
import { publicErrorResponse } from "@/server/public-api";

export const dynamic = "force-dynamic";

const MAX_RANGE_DAYS = 62;

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const url = new URL(req.url);
  const from = new Date(url.searchParams.get("from") ?? Date.now());
  const to = new Date(url.searchParams.get("to") ?? Date.now() + 14 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) {
    return NextResponse.json({ error: "Invalid from/to" }, { status: 400 });
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
    return NextResponse.json({ error: `Ask for at most ${MAX_RANGE_DAYS} days at a time` }, { status: 400 });
  }
  try {
    return NextResponse.json(await listAvailability(token, from, to));
  } catch (err) {
    return publicErrorResponse(err, "front-desk.availability");
  }
}
