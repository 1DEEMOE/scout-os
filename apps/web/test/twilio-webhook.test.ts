import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@wos/db";
import {
  approveAllTemplates,
  createOrg,
  enableFrontDesk,
  expectedTwilioSignature,
  findLeadByExternalKey,
  quickstartBusiness,
  setFrontDeskStatus,
  setSmsPortForTests,
  type SmsPort,
} from "@wos/core";
import { resetDb, seedUser } from "../../../packages/db/test/helpers";
import { POST as voicePost } from "../src/app/api/front-desk/[token]/voice/route";
import { POST as recordingPost } from "../src/app/api/front-desk/[token]/voice/recording/route";
import { POST as smsPost } from "../src/app/api/front-desk/[token]/sms/route";

const AUTH_TOKEN = "test_auth_token_123";
const BASE = "https://app.example.com";
const ORIGINAL_AUTH = process.env.TWILIO_AUTH_TOKEN;

let orgId: string;
let token: string;
let sentTexts: { to: string; body: string }[];

const fakePort: SmsPort = {
  mock: true,
  async send(msg) {
    sentTexts.push(msg);
    return { sid: `SM_fake_${sentTexts.length}`, mock: true };
  },
};

function signedReq(path: string, params: Record<string, string>, opts: { badSig?: boolean } = {}): Request {
  const url = `${BASE}${path}`;
  const signature = opts.badSig ? "AAAAbbbbCCCCddddEEEEffff0000=" : expectedTwilioSignature(AUTH_TOKEN, url, params);
  return new Request(url, {
    method: "POST",
    body: new URLSearchParams(params).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
  });
}

const ctx = (t: string) => ({ params: Promise.resolve({ token: t }) });

beforeEach(async () => {
  await resetDb();
  sentTexts = [];
  setSmsPortForTests(fakePort);
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  await seedUser("owner", "owner@example.test");
  orgId = (await createOrg({ actorUserId: "owner", name: "Northside Nails" })).orgId;
  await quickstartBusiness({ actorUserId: "owner", orgId, name: "Northside Nails", industry: "nail_salon", timezone: "America/Chicago" });
  await approveAllTemplates({ actorUserId: "owner", orgId });
  token = (await enableFrontDesk({ actorUserId: "owner", orgId, displayName: "Northside Nails", timezone: "America/Chicago" })).publicToken;
});

afterEach(() => {
  setSmsPortForTests(undefined);
  if (ORIGINAL_AUTH === undefined) delete process.env.TWILIO_AUTH_TOKEN;
  else process.env.TWILIO_AUTH_TOKEN = ORIGINAL_AUTH;
});

afterAll(async () => {
  await closePool();
});

describe("twilio voice webhook", () => {
  const callParams = { CallSid: "CA100", From: "+13125550100", To: "+15559876543" };

  it("answers a verified call with disclosure and a recording prompt", async () => {
    const res = await voicePost(signedReq(`/api/front-desk/${token}/voice`, callParams), ctx(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const twiml = await res.text();
    expect(twiml).toContain("This call may be recorded");
    expect(twiml).toContain("Northside Nails");
    expect(twiml).toContain(`<Record maxLength="120" playBeep="true" action="${BASE}/api/front-desk/${token}/voice/recording" method="POST" />`);
  });

  it("rejects a bad signature with 403 and answers nothing", async () => {
    const res = await voicePost(signedReq(`/api/front-desk/${token}/voice`, callParams, { badSig: true }), ctx(token));
    expect(res.status).toBe(403);
  });

  it("answers 404 when the feature is not configured", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const res = await voicePost(signedReq(`/api/front-desk/${token}/voice`, callParams), ctx(token));
    expect(res.status).toBe(404);
  });

  it("tells callers the line is unavailable when the desk is paused", async () => {
    const channels = await enableFrontDesk({ actorUserId: "owner", orgId, displayName: "Second Desk" });
    await setFrontDeskStatus({ actorUserId: "owner", orgId, channelId: channels.channelId, status: "paused" });
    const res = await voicePost(signedReq(`/api/front-desk/${channels.publicToken}/voice`, callParams), ctx(channels.publicToken));
    expect(await res.text()).toContain("not currently available");
  });
});

describe("twilio recording callback", () => {
  it("files the missed call, texts back once, and stays idempotent on retry", async () => {
    const params = { CallSid: "CA200", From: "+13125550100", To: "+15559876543", RecordingUrl: "https://api.twilio.com/rec/RE1", RecordingDuration: "37" };
    const path = `/api/front-desk/${token}/voice/recording`;
    const res = await recordingPost(signedReq(path, params), ctx(token));
    expect(res.status).toBe(200);

    const lead = await withTenant(orgId, (t) => findLeadByExternalKey(t, "twilio:call:CA200"));
    expect(lead?.outcome).toBe("sent");
    expect(lead?.recordingUrl).toBe("https://api.twilio.com/rec/RE1");
    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0]!.to).toBe("+13125550100");

    const retry = await recordingPost(signedReq(path, params), ctx(token));
    expect(retry.status).toBe(200);
    expect(sentTexts).toHaveLength(1);
  });
});

describe("twilio inbound sms webhook", () => {
  it("STOP blocks the number for the later missed-call text-back", async () => {
    const stopRes = await smsPost(signedReq(`/api/front-desk/${token}/sms`, { MessageSid: "SM300", From: "+13125550100", To: "+15559876543", Body: "STOP" }), ctx(token));
    expect(stopRes.status).toBe(200);

    await recordingPost(signedReq(`/api/front-desk/${token}/voice/recording`, { CallSid: "CA300", From: "+13125550100", To: "+15559876543" }), ctx(token));
    const lead = await withTenant(orgId, (t) => findLeadByExternalKey(t, "twilio:call:CA300"));
    expect(lead?.blockReason).toBe("stop");
    expect(sentTexts).toHaveLength(0);
  });

  it("a customer text files a lead and sends the pre-approved reply", async () => {
    const res = await smsPost(signedReq(`/api/front-desk/${token}/sms`, { MessageSid: "SM301", From: "+13125550100", To: "+15559876543", Body: "Do you have openings this week?" }), ctx(token));
    expect(res.status).toBe(200);
    const lead = await withTenant(orgId, (t) => findLeadByExternalKey(t, "twilio:sms:SM301"));
    expect(lead?.outcome).toBe("sent");
    expect(sentTexts).toHaveLength(1);
  });

  it("signs empty-valued params too (a stripped param must fail)", async () => {
    const params = { MessageSid: "SM302", From: "+13125550100", To: "+15559876543", Body: "", AccountSid: "" };
    const res = await smsPost(signedReq(`/api/front-desk/${token}/sms`, params), ctx(token));
    expect(res.status).toBe(200);
  });
});
