import { handleInboundSms } from "@wos/core";
import { NextResponse } from "next/server";
import { readTwilioForm, twimlResponse, verifyTwilioRequest } from "@/server/twilio";

export const dynamic = "force-dynamic";

/**
 * Inbound SMS webhook for the business line. STOP/START update the consent
 * ledger; other messages are filed as leads and handed to a person. Always
 * 200 with empty TwiML once verified — replies go out through the messaging
 * port, and a failed partial process must not trigger a blind Twilio retry.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const form = await readTwilioForm(req);
  if (form instanceof NextResponse) return form;
  const denied = verifyTwilioRequest(req, form);
  if (denied) return denied;
  const { twiml } = await handleInboundSms({
    publicToken: token,
    from: (form.From ?? "").slice(0, 40),
    to: (form.To ?? "").slice(0, 40),
    body: (form.Body ?? "").slice(0, 1600),
    messageSid: (form.MessageSid ?? form.SmsSid ?? "").slice(0, 64),
  });
  return twimlResponse(twiml);
}
