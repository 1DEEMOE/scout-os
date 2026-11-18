import { describe, expect, it } from "vitest";
import {
  InMemoryManagedNumberStore, ManagedNumberError, MockNumberProvisioner, TwilioNumberProvisioner, buildWebhookUrls, channelReadiness,
  numberProvisionerFromEnv, proposeNumbers, provisionManagedNumber, recordA2pStatus, releaseManagedNumber, repointManagedNumber,
  type ManagedNumberRecord, type ManagedNumberStore, type TwilioFetch,
} from "../src/speed/managed-number";

const TOKEN = "abcdefghijklmnopqrstuvwx";
const base = { businessName: "Ridge Roofing", publicBase: "https://app.example.com", publicToken: TOKEN, approval: { approvedBy: "user_owner", tier: 3 as const } };
const PHONE = "+14045550100";
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ManagedNumberError ? e.code : "other"));

describe("managed numbers: safety", () => {
  it("proposing never buys, and warns about cost and text-back", async () => {
    const port = new MockNumberProvisioner();
    const p = await proposeNumbers(port, "404", 3);
    expect(p.status).toBe("proposal_not_purchased");
    expect(p.approvalTier).toBe(3);
    expect(p.options).toHaveLength(3);
    expect(p.warnings.join(" ")).toMatch(/A2P 10DLC/);
    expect(p.warnings.join(" ")).toMatch(/MOCK/);
    expect(port.buys).toBe(0);
    expect(await code(proposeNumbers(port, "123"))).toBe("invalid_input");
  });

  it("refuses to buy without a named human approval (missing, system actor, low tier, blank)", async () => {
    for (const approval of [undefined, { approvedBy: "system:worker", tier: 3 as const }, { approvedBy: "  ", tier: 3 as const }, { approvedBy: "u", tier: 2 as unknown as 3 }]) {
      const port = new MockNumberProvisioner(); const store = new InMemoryManagedNumberStore();
      expect(await code(provisionManagedNumber({ ...base, port, store, tenantId: "t1", phone: PHONE, approval }))).toBe("approval_required");
      expect(port.buys).toBe(0);
      expect(store.rows.size).toBe(0);
    }
  });

  it("rejects non-US numbers, non-https bases, and bad tokens before spending anything", async () => {
    const port = new MockNumberProvisioner(); const store = new InMemoryManagedNumberStore();
    expect(await code(provisionManagedNumber({ ...base, port, store, tenantId: "t1", phone: "+442071838750" }))).toBe("invalid_input");
    expect(await code(provisionManagedNumber({ ...base, port, store, tenantId: "t1", phone: PHONE, publicBase: "http://app.example.com" }))).toBe("invalid_input");
    expect(await code(provisionManagedNumber({ ...base, port, store, tenantId: "t1", phone: PHONE, publicToken: "short" }))).toBe("invalid_input");
    expect(port.buys).toBe(0);
  });
});

describe("managed numbers: provisioning", () => {
  it("buys once, points webhooks at the tenant's front-desk token, and is idempotent", async () => {
    const port = new MockNumberProvisioner(); const store = new InMemoryManagedNumberStore();
    const a = await provisionManagedNumber({ ...base, port, store, tenantId: "t1", phone: PHONE });
    const b = await provisionManagedNumber({ ...base, port, store, tenantId: "t1", phone: PHONE });
    expect(a.status).toBe("active");
    expect(a.a2p).toBe("not_started");
    expect(b).toEqual(a);
    expect(port.buys).toBe(1);
    expect(port.owned.get(PHONE)!.urls).toEqual({ voiceUrl: `https://app.example.com/api/front-desk/${TOKEN}/voice`, smsUrl: `https://app.example.com/api/front-desk/${TOKEN}/sms` });
  });

  it("one number per workspace; a different number is a conflict", async () => {
    const port = new MockNumberProvisioner(); const store = new InMemoryManagedNumberStore();
    await provisionManagedNumber({ ...base, port, store, tenantId: "t1", phone: PHONE });
    expect(await code(provisionManagedNumber({ ...base, port, store, tenantId: "t1", phone: "+14045550101" }))).toBe("conflict");
    expect(port.buys).toBe(1);
  });

  it("a number held by another workspace is never taken", async () => {
    const port = new MockNumberProvisioner(); const store = new InMemoryManagedNumberStore();
    await provisionManagedNumber({ ...base, port, store, tenantId: "t1", phone: PHONE });
    expect(await code(provisionManagedNumber({ ...base, port, store, tenantId: "t2", phone: PHONE }))).toBe("conflict");
    expect(store.rows.has("t2")).toBe(false);
  });

  it("crash after buying but before saving: the retry reconciles and does NOT buy a second number", async () => {
    const port = new MockNumberProvisioner();
    const inner = new InMemoryManagedNumberStore();
    let puts = 0;
    const flaky: ManagedNumberStore = {
      get: (t) => inner.get(t), getByPhone: (p) => inner.getByPhone(p),
      async put(r: ManagedNumberRecord) { puts++; if (puts === 2) throw new Error("db down"); await inner.put(r); },
    };
    await expect(provisionManagedNumber({ ...base, port, store: flaky, tenantId: "t1", phone: PHONE })).rejects.toThrow("db down");
    expect(port.buys).toBe(1);
    expect(inner.rows.get("t1")!.status).toBe("reserving"); // intent was recorded first
    const rec = await provisionManagedNumber({ ...base, port, store: inner, tenantId: "t1", phone: PHONE });
    expect(rec.status).toBe("active");
    expect(rec.sid).toBe("PN_mock_1");
    expect(port.buys).toBe(1); // still one purchase
  });

  it("repoint updates webhooks after a link rotation; requires an active number", async () => {
    const port = new MockNumberProvisioner(); const store = new InMemoryManagedNumberStore();
    expect(await code(repointManagedNumber({ port, store, tenantId: "t1", publicBase: base.publicBase, publicToken: TOKEN }))).toBe("not_found");
    await provisionManagedNumber({ ...base, port, store, tenantId: "t1", phone: PHONE });
    const NEW = "ZYXWVUTSRQPONMLKJIHGFEDC";
    await repointManagedNumber({ port, store, tenantId: "t1", publicBase: base.publicBase, publicToken: NEW });
    expect(port.owned.get(PHONE)!.urls.voiceUrl).toContain(NEW);
    expect(port.owned.get(PHONE)!.urls.voiceUrl).not.toContain(TOKEN);
  });

  it("release needs approval, is idempotent, and frees the number", async () => {
    const port = new MockNumberProvisioner(); const store = new InMemoryManagedNumberStore();
    await provisionManagedNumber({ ...base, port, store, tenantId: "t1", phone: PHONE });
    expect(await code(releaseManagedNumber({ port, store, tenantId: "t1", approval: undefined }))).toBe("approval_required");
    expect(port.owned.size).toBe(1);
    const r = await releaseManagedNumber({ port, store, tenantId: "t1", approval: base.approval });
    expect(r.status).toBe("released");
    expect(port.owned.size).toBe(0);
    expect((await releaseManagedNumber({ port, store, tenantId: "t1", approval: base.approval })).status).toBe("released");
  });
});

describe("managed numbers: text-back gate (carrier registration)", () => {
  it("voice works at once; text-back stays off until A2P is approved", async () => {
    const port = new MockNumberProvisioner(); const store = new InMemoryManagedNumberStore();
    expect(channelReadiness(null)).toMatchObject({ voice: false, textBack: false });
    const rec = await provisionManagedNumber({ ...base, port, store, tenantId: "t1", phone: PHONE });
    expect(channelReadiness(rec)).toMatchObject({ voice: true, textBack: false });
    for (const s of ["pending", "rejected"] as const) expect(channelReadiness(await recordA2pStatus(store, "t1", s)).textBack).toBe(false);
    expect(channelReadiness(await recordA2pStatus(store, "t1", "approved"))).toEqual({ voice: true, textBack: true });
  });
});

describe("twilio live adapter (fake fetch; never contacts Twilio)", () => {
  const mk = (responses: Record<string, unknown>[], status = 200) => {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    const f: TwilioFetch = async (url, init) => { calls.push({ url, method: init.method, headers: init.headers, body: init.body }); const body = responses.shift() ?? {}; return { ok: status < 400, status, json: async () => body }; };
    return { f, calls };
  };

  it("searches, buys with signed-webhook URLs, updates, and releases using the right REST calls", async () => {
    const { f, calls } = mk([{ available_phone_numbers: [{ phone_number: "+14045550100", locality: "Atlanta", region: "GA" }] }, { sid: "PNabc" }, {}, {}]);
    const p = new TwilioNumberProvisioner("ACxxx", "tok", f);
    expect(await p.search({ areaCode: "404", limit: 2 })).toEqual([{ phone: "+14045550100", locality: "Atlanta", region: "GA" }]);
    expect(calls[0]!.url).toContain("/Accounts/ACxxx/AvailablePhoneNumbers/US/Local.json?");
    expect(calls[0]!.url).toContain("AreaCode=404");
    const urls = buildWebhookUrls("https://app.example.com", TOKEN);
    expect(await p.buy({ phone: PHONE, friendlyName: "x", urls })).toEqual({ sid: "PNabc", phone: PHONE });
    expect(calls[1]).toMatchObject({ method: "POST" });
    expect(calls[1]!.url).toMatch(/IncomingPhoneNumbers\.json$/);
    const form = new URLSearchParams(calls[1]!.body);
    expect(form.get("VoiceUrl")).toBe(urls.voiceUrl);
    expect(form.get("SmsUrl")).toBe(urls.smsUrl);
    expect(form.get("PhoneNumber")).toBe(PHONE);
    expect(calls[1]!.headers.authorization).toBe(`Basic ${Buffer.from("ACxxx:tok").toString("base64")}`);
    await p.updateWebhooks("PNabc", urls);
    expect(calls[2]!.url).toContain("/IncomingPhoneNumbers/PNabc.json");
    await p.release("PNabc");
    expect(calls[3]!.method).toBe("DELETE");
  });

  it("findOwned looks the number up before any purchase", async () => {
    const { f, calls } = mk([{ incoming_phone_numbers: [{ sid: "PNowned", phone_number: PHONE }] }, { incoming_phone_numbers: [] }]);
    const p = new TwilioNumberProvisioner("ACxxx", "tok", f);
    expect(await p.findOwned(PHONE)).toEqual({ sid: "PNowned", phone: PHONE });
    expect(calls[0]!.url).toContain("PhoneNumber=%2B14045550100");
    expect(await p.findOwned(PHONE)).toBeNull();
  });

  it("errors carry status and Twilio code only, never the phone number", async () => {
    const { f } = mk([{ code: 21452, message: `No available numbers like ${PHONE}` }], 400);
    const p = new TwilioNumberProvisioner("ACxxx", "tok", f);
    const e = await p.buy({ phone: PHONE, friendlyName: "x", urls: buildWebhookUrls("https://a.example.com", TOKEN) }).catch((x: Error) => x);
    expect((e as Error).message).toBe("twilio_failed:POST:400:21452");
    expect((e as Error).message).not.toContain("404");
  });

  it("spending is opt-in: credentials alone give no provisioner; mock mode gives the labelled mock", () => {
    expect(numberProvisionerFromEnv({ TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "t" })).toBeNull();
    expect(numberProvisionerFromEnv({ TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "t", WOS_MANAGED_NUMBERS: "1" })?.mock).toBe(false);
    expect(numberProvisionerFromEnv({ WOS_MOCK_MODE: "1", TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "t", WOS_MANAGED_NUMBERS: "1" })?.mock).toBe(true);
    expect(numberProvisionerFromEnv({})).toBeNull();
  });
});
