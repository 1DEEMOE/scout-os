import { createHash } from "node:crypto";

/**
 * Twilio-shaped messaging port. The only implementation that runs is the
 * MOCK adapter. There is no live Twilio client and no network send: a paid
 * account is not configured, and WOS_MOCK_MODE (the default for local and CI)
 * must not place a real call or text.
 */
export interface OutboundSms {
  to: string;
  body: string;
  idempotencyKey: string;
}

export interface SmsSendResult {
  sid: string;
  mock: true;
}

export interface SmsPort {
  readonly mock: true;
  send(msg: OutboundSms): Promise<SmsSendResult>;
}

const sent = new Map<string, SmsSendResult>();

/** Test hook. */
export function resetMockSms(): void {
  sent.clear();
}

export function mockSmsPort(): SmsPort {
  return {
    mock: true,
    async send(msg) {
      const prior = sent.get(msg.idempotencyKey);
      if (prior) return prior;
      const sid = `SM_mock_${createHash("sha256").update(msg.idempotencyKey).digest("hex").slice(0, 24)}`;
      const result: SmsSendResult = { sid, mock: true };
      sent.set(msg.idempotencyKey, result);
      return result;
    },
  };
}

/** Digits only, E.164 with a leading +. Ten-digit US numbers gain +1. */
export function normalizePhone(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length >= 10 && d.length <= 15) return `+${d}`;
  return null;
}

/** CTIA opt-out keywords. A match is a STOP, whatever else the thread said. */
const STOP = /^(stop|stopall|unsubscribe|cancel|end|quit)[.!]?$/i;

export function isStopKeyword(body: string): boolean {
  return STOP.test(body.trim());
}
