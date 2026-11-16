import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant, type Tx } from "@wos/db";
import {
  approveAllTemplates,
  createOrg,
  expectedTwilioSignature,
  findLeadByExternalKey,
  inboundSmsReceived,
  ingestLead,
  missedCallReceived,
  quickstartBusiness,
  resetMockSms,
  resetSmsPorts,
  setSmsPortForTests,
  smsPortForSend,
  systemRecordSmsStop,
  twilioSmsPort,
  validTwilioSignature,
  type SmsPort,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

const ENV_KEYS = ["WOS_MOCK_MODE", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"] as const;
const ORIGINAL_ENV = { ...process.env };

const NOON_CHICAGO = new Date("2026-06-15T17:00:00Z"); // 12:00 CDT — inside the text window
const EARLY_CHICAGO = new Date("2026-06-15T12:00:00Z"); // 07:00 CDT — quiet hours

let orgId: string;
let sentTexts: { to: string; body: string; idempotencyKey: string; tenantId?: string }[];

const fakePort: SmsPort = {
  mock: true,
  async send(msg) {
    sentTexts.push(msg);
    return { sid: `SM_fake_${sentTexts.length}`, mock: true };
  },
};

beforeEach(async () => {
  await resetDb();
  resetMockSms();
  resetSmsPorts();
  sentTexts = [];
  setSmsPortForTests(fakePort);
  await seedUser("owner", "owner@example.test");
  orgId = (await createOrg({ actorUserId: "owner", name: "Northside Nails" })).orgId;
  await quickstartBusiness({ actorUserId: "owner", orgId, name: "Northside Nails", industry: "nail_salon", timezone: "America/Chicago" });
  await approveAllTemplates({ actorUserId: "owner", orgId });
});

afterEach(() => {
  setSmsPortForTests(undefined);
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
});

afterAll(async () => {
  await closePool();
});

function tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
  return withTenant(orgId, fn);
}

describe("twilio signature validation", () => {
  const token = "test_auth_token_123";
  const url = "https://app.example.com/api/front-desk/TOK123/voice";
  const params = { CallSid: "CA123", From: "+13125550100", To: "+15559876543" };

  it("matches a precomputed vector (URL + sorted params, HMAC-SHA1, base64)", () => {
    expect(expectedTwilioSignature(token, url, params)).toBe("miSmQgOMDXWvHgYFuvj3zYBC8UM=");
  });

  it("keeps empty-valued params in the signature", () => {
    const p = { Body: "STOP", From: "+13125550100", MessageSid: "SM123", To: "+15559876543", OptionalEmpty: "" };
    expect(expectedTwilioSignature(token, "https://app.example.com/api/front-desk/TOK123/sms", p)).toBe("s7VPawJ+1j12tF3eR04Oa/lSet4=");
  });

  it("accepts any matching candidate URL and rejects tampering", () => {
    const sig = expectedTwilioSignature(token, url, params);
    expect(validTwilioSignature(token, ["http://internal:3000/x", url], params, sig)).toBe(true);
    expect(validTwilioSignature(token, ["http://internal:3000/x"], params, sig)).toBe(false);
    expect(validTwilioSignature(token, [url], { ...params, From: "+13125550199" }, sig)).toBe(false);
    expect(validTwilioSignature(token, [url], params, null)).toBe(false);
    expect(validTwilioSignature(undefined, [url], params, sig)).toBe(false);
    expect(validTwilioSignature("wrong_token", [url], params, sig)).toBe(false);
  });
});

describe("twilioSmsPort (live REST send)", () => {
  const config = { accountSid: "AC123", authToken: "tok", fromNumber: "+15559876543" };

  function stubFetch(status: number, body: unknown) {
    const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
    const fn = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      calls.push({ url, init });
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
    return { calls, fn };
  }

  it("posts the message to the Twilio API with basic auth", async () => {
    const { calls, fn } = stubFetch(201, { sid: "SM_live_1" });
    const port = twilioSmsPort(config, "+15559876543", fn);
    const res = await port.send({ to: "+13125550100", body: "hi", idempotencyKey: "k1", tenantId: "t1" });
    expect(res).toEqual({ sid: "SM_live_1", mock: false });
    expect(port.mock).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(calls[0]!.init.headers.authorization).toBe(`Basic ${Buffer.from("AC123:tok").toString("base64")}`);
    expect(calls[0]!.init.body).toBe(new URLSearchParams({ To: "+13125550100", From: "+15559876543", Body: "hi" }).toString());
  });

  it("fails with status and Twilio code only — never the phone number from the error body", async () => {
    const { fn } = stubFetch(400, { code: 21211, message: "Invalid 'To' Phone Number: +13125550100" });
    const port = twilioSmsPort(config, "+15559876543", fn);
    const err: Error = await port.send({ to: "+13125550100", body: "hi", idempotencyKey: "k2", tenantId: "t1" }).then(
      () => {
        throw new Error("should have failed");
      },
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain("twilio_send_failed:400:21211");
    expect(err.message).not.toContain("3125550100");
  });

  it("requires a tenantId for the journal and breaker", async () => {
    const { fn } = stubFetch(201, { sid: "SMx" });
    await expect(twilioSmsPort(config, "+15559876543", fn).send({ to: "+1", body: "x", idempotencyKey: "k3" })).rejects.toThrow(/tenantId/);
  });
});

describe("smsPortForSend selection", () => {
  it("is the pinned port in tests, the MOCK in mock mode, live only when fully configured", () => {
    expect(smsPortForSend().mock).toBe(true); // pinned fake
    setSmsPortForTests(undefined);

    process.env.WOS_MOCK_MODE = "1";
    process.env.TWILIO_ACCOUNT_SID = "AC";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_FROM_NUMBER = "+15559876543";
    expect(smsPortForSend().mock).toBe(true); // mock mode always wins

    delete process.env.WOS_MOCK_MODE;
    expect(smsPortForSend().mock).toBe(false); // fully configured
    expect(smsPortForSend("+15550001111")).toBe(smsPortForSend("+15550001111")); // cached per from-number

    delete process.env.TWILIO_FROM_NUMBER;
    expect(smsPortForSend().mock).toBe(true); // creds but nothing to send from
    expect(smsPortForSend("+15550002222").mock).toBe(false); // per-call from-number covers it

    delete process.env.TWILIO_ACCOUNT_SID;
    expect(smsPortForSend("+15550002222").mock).toBe(true); // no creds → MOCK
  });
});

describe("missedCallReceived", () => {
  const call = { from: "3125550100", to: "15559876543", businessName: "Northside Nails", timezone: "America/Chicago" };

  it("answers with one pre-approved text-back, attaches the voicemail, opens a follow-up task", async () => {
    const r = await tx((t) => missedCallReceived(t, orgId, { ...call, callSid: "CA1", recordingUrl: "https://api.twilio.com/rec/RE1", recordingDurationSec: 42, now: NOON_CHICAGO }));
    expect(r.lead.source).toBe("missed_call");
    expect(r.lead.outcome).toBe("sent");
    expect(r.lead.recordingUrl).toBe("https://api.twilio.com/rec/RE1");
    expect(r.voicemailTaskId).toBeTruthy();
    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0]!.to).toBe("+13125550100");
    expect(sentTexts[0]!.body).toContain("Northside Nails");
    expect(sentTexts[0]!.tenantId).toBe(orgId);
  });

  it("is idempotent by call ID: a webhook retry never double-texts or double-tasks", async () => {
    const input = { ...call, callSid: "CA2", recordingUrl: "https://api.twilio.com/rec/RE2", now: NOON_CHICAGO };
    const first = await tx((t) => missedCallReceived(t, orgId, input));
    const again = await tx((t) => missedCallReceived(t, orgId, input));
    expect(again.lead.id).toBe(first.lead.id);
    expect(again.voicemailTaskId).toBeUndefined();
    expect(sentTexts).toHaveLength(1);
  });

  it("records a second call inside 24h but does not text again", async () => {
    await tx((t) => missedCallReceived(t, orgId, { ...call, callSid: "CA3a", now: NOON_CHICAGO }));
    const second = await tx((t) => missedCallReceived(t, orgId, { ...call, callSid: "CA3b", now: new Date(NOON_CHICAGO.getTime() + 3_600_000) }));
    expect(second.lead.outcome).toBe("blocked");
    expect(second.lead.blockReason).toBe("recent_textback");
    expect(sentTexts).toHaveLength(1);
  });

  it("texts back with no prior consent record, but that creates no consent for follow-ups", async () => {
    const r = await tx((t) => missedCallReceived(t, orgId, { ...call, callSid: "CA4", now: NOON_CHICAGO }));
    expect(r.lead.outcome).toBe("sent"); // inbound-initiated: they called first

    const followUp = await ingestLead({ actorUserId: "owner", orgId, source: "web_form", externalKey: "web-1", phone: call.from, timezone: "America/Chicago", now: new Date(NOON_CHICAGO.getTime() + 25 * 3_600_000) });
    expect(followUp.outcome).toBe("blocked");
    expect(followUp.blockReason).toBe("no_consent");
  });

  it("never texts a number that said STOP, and honors quiet hours", async () => {
    await tx((t) => systemRecordSmsStop(t, orgId, "3125550100"));
    const stopped = await tx((t) => missedCallReceived(t, orgId, { ...call, callSid: "CA5", now: NOON_CHICAGO }));
    expect(stopped.lead.outcome).toBe("blocked");
    expect(stopped.lead.blockReason).toBe("stop");

    const quiet = await tx((t) => missedCallReceived(t, orgId, { ...call, from: "3125550777", callSid: "CA6", now: EARLY_CHICAGO }));
    expect(quiet.lead.outcome).toBe("blocked");
    expect(quiet.lead.blockReason).toBe("quiet_hours");
    expect(sentTexts).toHaveLength(0);
  });
});

describe("inboundSmsReceived", () => {
  const line = { to: "15559876543", businessName: "Northside Nails", timezone: "America/Chicago" };

  it("STOP hard-blocks the number; START restores it with recorded consent", async () => {
    const stop = await tx((t) => inboundSmsReceived(t, orgId, { ...line, messageSid: "SM1", from: "3125550100", body: "STOP", now: NOON_CHICAGO }));
    expect(stop.action).toBe("stopped");
    const blocked = await tx((t) => missedCallReceived(t, orgId, { from: "3125550100", to: line.to, callSid: "CA9", now: NOON_CHICAGO }));
    expect(blocked.lead.blockReason).toBe("stop");

    const start = await tx((t) => inboundSmsReceived(t, orgId, { ...line, messageSid: "SM2", from: "3125550100", body: "start", now: NOON_CHICAGO }));
    expect(start.action).toBe("started");
    // START recorded real consent: even a staff-ingested outbound reply now passes the gate.
    const sent = await ingestLead({ actorUserId: "owner", orgId, source: "web_form", externalKey: "web-after-start", phone: "3125550100", timezone: "America/Chicago", now: new Date(NOON_CHICAGO.getTime() + 25 * 3_600_000) });
    expect(sent.outcome).toBe("sent");
  });

  it("files a customer text as a lead plus a task, and replies at most once per 24h", async () => {
    const first = await tx((t) => inboundSmsReceived(t, orgId, { ...line, messageSid: "SM10", from: "3125550100", body: "Do you do gel fills?", now: NOON_CHICAGO }));
    expect(first.action).toBe("received");
    expect(first.lead?.outcome).toBe("sent");
    expect(first.taskId).toBeTruthy();

    const second = await tx((t) => inboundSmsReceived(t, orgId, { ...line, messageSid: "SM11", from: "3125550100", body: "Any openings Friday?", now: new Date(NOON_CHICAGO.getTime() + 600_000) }));
    expect(second.lead?.outcome).toBe("blocked");
    expect(second.lead?.blockReason).toBe("recent_textback");
    expect(sentTexts).toHaveLength(1);
  });

  it("is idempotent by message ID: a retry does not reopen the task", async () => {
    const input = { ...line, messageSid: "SM12", from: "3125550100", body: "hello", now: NOON_CHICAGO };
    const first = await tx((t) => inboundSmsReceived(t, orgId, input));
    const again = await tx((t) => inboundSmsReceived(t, orgId, input));
    expect(again.lead?.id).toBe(first.lead?.id);
    expect(again.taskId).toBeUndefined();
    expect(sentTexts).toHaveLength(1);
  });

  it("ignores an unparseable caller without throwing", async () => {
    const r = await tx((t) => inboundSmsReceived(t, orgId, { ...line, messageSid: "SM13", from: "unknown", body: "hi", now: NOON_CHICAGO }));
    expect(r.action).toBe("received");
    expect(r.lead).toBeUndefined();
  });
});

describe("findLeadByExternalKey", () => {
  it("returns the stored lead and null for unknown keys", async () => {
    await tx((t) => missedCallReceived(t, orgId, { from: "3125550100", to: "15559876543", callSid: "CA20", now: NOON_CHICAGO }));
    const found = await tx((t) => findLeadByExternalKey(t, "twilio:call:CA20"));
    expect(found?.source).toBe("missed_call");
    expect(await tx((t) => findLeadByExternalKey(t, "twilio:call:nope"))).toBeNull();
  });
});
