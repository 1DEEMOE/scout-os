import { handleVoiceRecording } from "@wos/core";
import { NextResponse } from "next/server";
import { readTwilioForm, twimlResponse, verifyTwilioRequest } from "@/server/twilio";

export const dynamic = "force-dynamic";

/**
 * Recording callback from the voice webhook's <Record action>. Files the
 * missed call (idempotent by CallSid), sends the one text-back, and opens a
 * follow-up task. A 500 makes Twilio retry — safe because of the idempotency
 * key, and wanted: losing a voicemail is worse than processing it twice.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const form = await readTwilioForm(req);
  if (form instanceof NextResponse) return form;
  const denied = verifyTwilioRequest(req, form);
  if (denied) return denied;
  const duration = Number(form.RecordingDuration ?? "");
  await handleVoiceRecording({
    publicToken: token,
    from: (form.From ?? "").slice(0, 40),
    to: (form.To ?? "").slice(0, 40),
    callSid: (form.CallSid ?? "").slice(0, 64),
    recordingUrl: form.RecordingUrl ? form.RecordingUrl.slice(0, 300) : undefined,
    recordingDurationSec: Number.isInteger(duration) && duration >= 0 && duration < 3600 ? duration : undefined,
  });
  return twimlResponse(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
}
