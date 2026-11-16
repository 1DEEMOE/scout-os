import { logger, validTwilioSignature } from "@wos/core";
import { NextResponse } from "next/server";
import { PUBLIC_MAX_BODY_BYTES } from "./public-api";

/**
 * Shared plumbing for Twilio webhooks (voice, recording, inbound SMS).
 * Twilio posts application/x-www-form-urlencoded and signs the full public
 * URL plus every POST parameter — so the body must be parsed keeping empty
 * values, and the URL must be rebuilt the way Twilio saw it.
 */

/** Parses the form body, keeping empty-valued params (they are signed). */
export async function readTwilioForm(req: Request): Promise<Record<string, string> | NextResponse> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > PUBLIC_MAX_BODY_BYTES) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  const text = await req.text();
  if (Buffer.byteLength(text) > PUBLIC_MAX_BODY_BYTES) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(text)) params[k] = v;
  return params;
}

/**
 * The URLs Twilio may have signed: the request URL as the app sees it, and
 * the public URL rebuilt from the proxy's forwarded headers (Twilio signs the
 * public one; behind a load balancer the app sees an internal host).
 */
export function twilioUrlCandidates(req: Request): string[] {
  const urls = [req.url];
  const proto = req.headers.get("x-forwarded-proto");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (proto && host) {
    const u = new URL(req.url);
    urls.push(`${proto}://${host}${u.pathname}${u.search}`);
  }
  return [...new Set(urls)];
}

/** The public base URL (proto://host) for building absolute callback URLs. */
export function twilioPublicBase(req: Request): string {
  const proto = req.headers.get("x-forwarded-proto");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (proto && host) return `${proto}://${host}`;
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}

/**
 * Hard gate: the feature is off without TWILIO_AUTH_TOKEN (404, same as an
 * unknown route, so the endpoint's existence is not advertised), a missing or
 * bad signature is a 403. Returns null when the request is verified Twilio.
 */
export function verifyTwilioRequest(req: Request, params: Record<string, string>): NextResponse | null {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const signature = req.headers.get("x-twilio-signature");
  if (!validTwilioSignature(authToken, twilioUrlCandidates(req), params, signature)) {
    logger.warn({ path: new URL(req.url).pathname }, "twilio webhook signature rejected");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }
  return null;
}

export function twimlResponse(twiml: string): Response {
  return new Response(twiml, { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } });
}
