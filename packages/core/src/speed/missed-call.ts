import { withTenant } from "@wos/db";
import { recordAudit } from "../audit";
import { logger } from "../logger";
import { getChannelByToken } from "../front-desk/service";
import { inboundSmsReceived, missedCallReceived, type InboundSmsResult, type MissedCallResult } from "./service";

/**
 * Missed-call answering, Twilio edge. These handlers are called only after
 * the route has verified the X-Twilio-Signature, so the caller is Twilio and
 * the channel token in the URL names the tenant's front desk. The phone line
 * reuses the existing front-desk channel: one front desk, two surfaces (the
 * booking link and the phone line). Rotating the link rotates the webhook
 * URL too, so the Twilio console must be updated after a rotation.
 *
 * What this feature never does: compose a reply with an AI model, send a
 * follow-up without recorded consent, or text anyone who said STOP. The
 * single text-back is always a template a person approved, and TCPA review
 * of that template remains the owner's outstanding task (see .env.example).
 */

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const EMPTY_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

function sayTwiml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">${xmlEscape(message)}</Say></Response>`;
}

/**
 * TwiML for an answered missed call: a recording disclosure up front (call
 * recording laws are two-party-consent in some states), then a message is
 * taken. The recording posts to `recordingActionUrl`.
 */
export function voiceAnswerTwiml(opts: { businessName: string; recordingActionUrl: string }): string {
  const greeting =
    `Thank you for calling ${opts.businessName}. This call may be recorded. ` +
    `We're sorry we missed you. Please leave your name, number, and what you need after the beep, ` +
    `and we'll text you back shortly.`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Say voice="alice">${xmlEscape(greeting)}</Say>` +
    `<Record maxLength="120" playBeep="true" action="${xmlEscape(opts.recordingActionUrl)}" method="POST" />` +
    `<Say voice="alice">We didn't receive a message, but we'll still text you back shortly. Goodbye.</Say>` +
    `</Response>`
  );
}

export interface TwilioVoiceInput {
  publicToken: string;
  from: string;
  to: string;
  callSid: string;
  /** Absolute URL Twilio should post the recording to (built by the route). */
  recordingActionUrl: string;
}

/**
 * Voice webhook: answer with disclosure + voicemail. Unknown or paused lines
 * get a polite not-in-service message instead of an error tone.
 */
export async function handleInboundVoice(input: TwilioVoiceInput): Promise<string> {
  const ch = await getChannelByToken(input.publicToken);
  if (!ch || ch.status !== "active") return sayTwiml("This answering service is not currently available. Goodbye.");
  if (!input.callSid || input.callSid.length > 64) return sayTwiml("We're unable to take your call right now. Goodbye.");
  await withTenant(ch.tenantId, async (tx) => {
    await recordAudit(tx, {
      tenantId: ch.tenantId,
      actorType: "system",
      actorId: "twilio",
      action: "voice.answer",
      target: `front_desk_channel:${ch.id}`,
      tier: 1,
      outcome: "success",
      metadata: { last4: input.from.replace(/\D/g, "").slice(-4) || null },
    });
  });
  return voiceAnswerTwiml({ businessName: ch.displayName, recordingActionUrl: input.recordingActionUrl });
}

export interface TwilioRecordingInput {
  publicToken: string;
  from: string;
  to: string;
  callSid: string;
  recordingUrl?: string;
  recordingDurationSec?: number;
}

/**
 * Recording callback (also fires with no recording when the caller hung up):
 * file the missed call, send the one text-back, open the follow-up task.
 * Idempotent by call ID, so Twilio retries never double-text.
 */
export async function handleVoiceRecording(input: TwilioRecordingInput): Promise<MissedCallResult | null> {
  const ch = await getChannelByToken(input.publicToken);
  if (!ch || ch.status !== "active") return null;
  if (!input.callSid || input.callSid.length > 64) return null;
  return withTenant(ch.tenantId, async (tx) =>
    missedCallReceived(tx, ch.tenantId, {
      callSid: input.callSid,
      from: input.from,
      to: input.to,
      businessName: ch.displayName,
      timezone: ch.timezone,
      recordingUrl: input.recordingUrl,
      recordingDurationSec: input.recordingDurationSec,
    }),
  );
}

export interface TwilioSmsInput {
  publicToken: string;
  from: string;
  to: string;
  body: string;
  messageSid: string;
}

/**
 * Inbound SMS webhook: STOP/START update the consent ledger; anything else is
 * filed and handed to a person. Always answers with empty TwiML — replies go
 * out through the messaging port so idempotency, the breaker, and the MOCK
 * label stay in one place.
 */
export async function handleInboundSms(input: TwilioSmsInput): Promise<{ twiml: string; result: InboundSmsResult | null }> {
  const ch = await getChannelByToken(input.publicToken);
  if (!ch || ch.status !== "active") return { twiml: EMPTY_TWIML, result: null };
  if (!input.messageSid || input.messageSid.length > 64 || input.body.length > 1600) {
    return { twiml: EMPTY_TWIML, result: null };
  }
  try {
    const result = await withTenant(ch.tenantId, async (tx) =>
      inboundSmsReceived(tx, ch.tenantId, {
        messageSid: input.messageSid,
        from: input.from,
        to: input.to,
        body: input.body,
        businessName: ch.displayName,
        timezone: ch.timezone,
      }),
    );
    return { twiml: EMPTY_TWIML, result };
  } catch (err) {
    // A failed handler must not make Twilio retry a message we may have
    // partially processed; the lead is idempotent by message ID, so log and
    // ack, and let a person resend from the thread if needed.
    logger.error({ err, orgId: ch.tenantId }, "inbound SMS handling failed");
    return { twiml: EMPTY_TWIML, result: null };
  }
}
