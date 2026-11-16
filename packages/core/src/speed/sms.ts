import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { produceIntegration, integrationKey } from "../events/produce";
import { logger } from "../logger";

/**
 * Twilio-shaped messaging port. The MOCK adapter is the default everywhere:
 * WOS_MOCK_MODE (local and CI) must not place a real call or text, and a
 * deployment without TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN has nothing to send
 * with, so it also gets the labelled MOCK. The live adapter only exists when
 * those credentials AND a from-number are present.
 */
export interface OutboundSms {
  to: string;
  body: string;
  idempotencyKey: string;
  /** Required by the live port for the event journal and circuit breaker. */
  tenantId?: string;
}

export interface SmsSendResult {
  sid: string;
  mock: boolean;
}

export interface SmsPort {
  readonly mock: boolean;
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

/** CTIA opt-back-in keyword. */
const START = /^(start|unstop)[.!]?$/i;

export function isStartKeyword(body: string): boolean {
  return START.test(body.trim());
}

/* ------------------------------------------------------------------ */
/* Live Twilio REST send                                               */
/* ------------------------------------------------------------------ */

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** Platform default sender; per-message `from` (the called number) wins. */
  fromNumber?: string;
}

/** Null unless both credentials are set — the feature fails closed. */
export function twilioConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken) return null;
  return { accountSid, authToken, fromNumber: env.TWILIO_FROM_NUMBER?.trim() || undefined };
}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Live sender: one Messages.json call per text, wrapped in the integration
 * bus so a flapping Twilio trips the circuit breaker and failures dead-letter.
 * The 10s timeout and the breaker are the whole retry story — a blind retry
 * of an SMS can double-text the customer, so a failure surfaces as a dead
 * letter for a person instead.
 */
export function twilioSmsPort(config: TwilioConfig, fromNumber: string, fetchFn?: FetchFn): SmsPort {
  const doFetch: FetchFn =
    fetchFn ??
    (async (url, init) => {
      const res = await fetch(url, init);
      return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown> };
    });
  return {
    mock: false,
    async send(msg) {
      if (!msg.tenantId) throw new Error("live SMS sends need a tenantId");
      return produceIntegration({
        tenantId: msg.tenantId,
        integration: "sms",
        idempotencyKey: integrationKey(`sms:${msg.idempotencyKey}`),
        mock: false,
        timeoutMs: 15_000,
        effect: async () => {
          const res = await doFetch(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`, {
            method: "POST",
            headers: {
              authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ To: msg.to, From: fromNumber, Body: msg.body }).toString(),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) {
            // Twilio's error body can quote the phone number — log status and
            // Twilio's numeric code only, never the message text (PII).
            const code = await res.json().then((b) => (b && typeof b === "object" ? String((b as { code?: unknown }).code ?? "") : "")).catch(() => "");
            throw new Error(`twilio_send_failed:${res.status}${code ? `:${code}` : ""}`);
          }
          const body = (await res.json()) as { sid?: unknown };
          return { sid: typeof body.sid === "string" ? body.sid : "SM_unknown", mock: false };
        },
      });
    },
  };
}

let pinnedPort: SmsPort | undefined;
/** Tests pin a port (e.g. a recording fake). Pass undefined to unpin. */
export function setSmsPortForTests(port: SmsPort | undefined): void {
  pinnedPort = port;
}

const livePorts = new Map<string, SmsPort>();
let warnedNoConfig = false;

/** Test hook: drop cached live ports and the warning latch. */
export function resetSmsPorts(): void {
  livePorts.clear();
  warnedNoConfig = false;
}

/**
 * The port a send should use right now. Live only with credentials AND a
 * from-number outside mock mode; the labelled MOCK otherwise. `fromNumber`
 * is the number the customer contacted (per-tenant line) and beats the
 * platform default TWILIO_FROM_NUMBER.
 */
export function smsPortForSend(fromNumber?: string): SmsPort {
  if (pinnedPort) return pinnedPort;
  if (process.env.WOS_MOCK_MODE === "1") return mockSmsPort();
  const config = twilioConfigFromEnv();
  const from = fromNumber ?? config?.fromNumber;
  if (!config || !from) {
    if (!warnedNoConfig) {
      warnedNoConfig = true;
      logger.warn("Twilio is not configured (TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER); SMS sends stay MOCK");
    }
    return mockSmsPort();
  }
  let port = livePorts.get(from);
  if (!port) {
    port = twilioSmsPort(config, from);
    livePorts.set(from, port);
  }
  return port;
}

/* ------------------------------------------------------------------ */
/* Webhook signature validation                                        */
/* ------------------------------------------------------------------ */

/**
 * Twilio signs the full request URL plus every POST parameter, sorted by name
 * (case-sensitive byte order) and appended as name+value with no delimiters,
 * HMAC-SHA1 keyed by the auth token, base64-encoded. Empty-valued params must
 * be kept. See twilio.com/docs/usage/security.
 */
export function expectedTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}

/**
 * Constant-time check against every candidate URL (the URL as the app sees it
 * and the public URL rebuilt from forwarded headers — proxies rewrite what
 * Twilio signed). Any match validates. Never throws.
 */
export function validTwilioSignature(authToken: string | undefined, urls: string[], params: Record<string, string>, signature: string | null): boolean {
  if (!authToken || !signature) return false;
  const got = Buffer.from(signature);
  for (const url of urls) {
    const expected = Buffer.from(expectedTwilioSignature(authToken, url, params));
    if (expected.length === got.length && timingSafeEqual(expected, got)) return true;
  }
  return false;
}
