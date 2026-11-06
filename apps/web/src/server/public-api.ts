import { AppError, logger } from "@wos/core";
import { NextResponse } from "next/server";

/**
 * Helpers for unauthenticated endpoints (public booking links).
 *
 * Client IP: the left-most X-Forwarded-For entry is whatever the caller sent,
 * so keying a rate limit on it lets anyone rotate fake IPs. Each proxy we run
 * behind appends the address it saw, so the trustworthy entry is the N-th from
 * the right, where N = WOS_TRUSTED_PROXY_HOPS (default 1: Render's load
 * balancer). Set it to the number of proxies in front of the app (2 with
 * Cloudflare in front of Render). With 0, forwarded headers are ignored and
 * all callers share one bucket (safe, just coarse).
 */
export function clientIp(headers: Headers): string {
  const hops = Number(process.env.WOS_TRUSTED_PROXY_HOPS ?? "1");
  if (!Number.isInteger(hops) || hops <= 0) return "unknown";
  const chain = (headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (chain.length === 0) return headers.get("x-real-ip")?.trim() || "unknown";
  return chain[Math.max(0, chain.length - hops)]!;
}

/** Largest JSON body a public endpoint accepts (a booking is well under 2 KB). */
export const PUBLIC_MAX_BODY_BYTES = 16_384;

/** Reads a JSON object body with a size cap. Returns a Response on failure. */
export async function readJsonBody(req: Request): Promise<Record<string, unknown> | NextResponse> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > PUBLIC_MAX_BODY_BYTES) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  const text = await req.text();
  if (Buffer.byteLength(text) > PUBLIC_MAX_BODY_BYTES) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
}

const STATUS: Partial<Record<AppError["code"], number>> = { NOT_FOUND: 404, RATE_LIMITED: 429, CONFLICT: 409, VALIDATION: 400 };

/**
 * Typed errors carry a message that's safe to show. Anything else is a bug or
 * an outage: log it with context and return a generic 500, never the raw
 * message (it can hold SQL, hostnames or stack details).
 */
export function publicErrorResponse(err: unknown, route: string): NextResponse {
  if (err instanceof AppError) return NextResponse.json({ error: err.message, code: err.code }, { status: STATUS[err.code] ?? 400 });
  logger.error({ err, route }, "public endpoint failed");
  return NextResponse.json({ error: "Something went wrong. Try again in a moment." }, { status: 500 });
}
