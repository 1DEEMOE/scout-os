import { handleInboundVoice, logger } from "@wos/core";
import { NextResponse } from "next/server";
import { readTwilioForm, twilioPublicBase, twimlResponse, verifyTwilioRequest } from "@/server/twilio";

export const dynamic = "force-dynamic";

const FALLBACK_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">We're unable to take your call right now. Please try again later. Goodbye.</Say></Response>`;

/**
 * Twilio voice webhook for the missed-call answering line. Server-to-server:
 * no Origin header, no session cookie — the X-Twilio-Signature is the
 * credential. Answers with disclosure + voicemail TwiML.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const form = await readTwilioForm(req);
  if (form instanceof NextResponse) return form;
  const denied = verifyTwilioRequest(req, form);
  if (denied) return denied;
  try {
    const twiml = await handleInboundVoice({
      publicToken: token,
      from: (form.From ?? "").slice(0, 40),
      to: (form.To ?? "").slice(0, 40),
      callSid: (form.CallSid ?? "").slice(0, 64),
      recordingActionUrl: `${twilioPublicBase(req)}/api/front-desk/${encodeURIComponent(token)}/voice/recording`,
    });
    return twimlResponse(twiml);
  } catch (err) {
    // A 500 makes Twilio play an error tone; a graceful apology is the better
    // caller experience. The error is logged loudly for the on-call human.
    logger.error({ err }, "twilio voice webhook failed");
    return twimlResponse(FALLBACK_TWIML);
  }
}
