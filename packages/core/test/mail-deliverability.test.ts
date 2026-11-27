import { describe, expect, it } from "vitest";
import { InMemorySuppressionStore, SOFT_BOUNCE_LIMIT, handleMailEvent, parsePostmarkEvent, parseSesEvents, webhookSecretOk } from "../src/mail/bounces";
import { PostmarkMailSender, SuppressingMailSender } from "../src/mail/postmark";
import { evaluateDomainAuth } from "../src/mail/dns-auth";
import { ConsoleMailSender } from "../src/mail/sender";

describe("bounce parsing", () => {
  it("postmark: hard, soft, complaint, unknown", () => {
    expect(parsePostmarkEvent({ RecordType: "Bounce", Type: "HardBounce", Email: "A@X.test" })).toMatchObject({ kind: "hard_bounce", address: "a@x.test" });
    expect(parsePostmarkEvent({ RecordType: "Bounce", Type: "SoftBounce", Email: "a@x.test" })?.kind).toBe("soft_bounce");
    expect(parsePostmarkEvent({ RecordType: "SpamComplaint", Email: "a@x.test" })?.kind).toBe("complaint");
    expect(parsePostmarkEvent({ RecordType: "Bounce", Type: "SomethingNew", Email: "a@x.test" })).toBeNull();
    expect(parsePostmarkEvent({ RecordType: "Delivery", Email: "a@x.test" })).toBeNull();
    expect(parsePostmarkEvent(null)).toBeNull();
  });
  it("ses: permanent vs transient bounce, complaint, malformed", () => {
    const perm = JSON.stringify({ notificationType: "Bounce", bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "B@x.test" }, { emailAddress: "c@x.test" }] } });
    expect(parseSesEvents(perm).map((e) => [e.kind, e.address])).toEqual([["hard_bounce", "b@x.test"], ["hard_bounce", "c@x.test"]]);
    expect(parseSesEvents({ notificationType: "Bounce", bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "d@x.test" }] } })[0]!.kind).toBe("soft_bounce");
    expect(parseSesEvents({ notificationType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: "e@x.test" }] } })[0]!.kind).toBe("complaint");
    expect(parseSesEvents("not json")).toEqual([]);
  });
});

describe("suppression decisions", () => {
  it("hard bounce and complaint suppress immediately; soft bounce only at the limit", async () => {
    const s = new InMemorySuppressionStore();
    expect(await handleMailEvent(s, { kind: "hard_bounce", address: "a@x.test", provider: "ses" })).toBe("suppressed");
    expect(await handleMailEvent(s, { kind: "complaint", address: "b@x.test", provider: "ses" })).toBe("suppressed");
    for (let i = 1; i < SOFT_BOUNCE_LIMIT; i++) expect(await handleMailEvent(s, { kind: "soft_bounce", address: "c@x.test", provider: "ses" })).toBe("counted");
    expect(await s.isSuppressed("c@x.test")).toBe(false);
    expect(await handleMailEvent(s, { kind: "soft_bounce", address: "c@x.test", provider: "ses" })).toBe("suppressed");
    expect(s.suppressed.get("b@x.test")).toBe("complaint");
  });
  it("suppressing sender refuses suppressed recipients and passes others", async () => {
    const s = new InMemorySuppressionStore(); await s.suppress("bad@x.test", "bounce");
    const inner = new ConsoleMailSender(); const m = new SuppressingMailSender(inner, s);
    await expect(m.send({ to: "BAD@x.test", subject: "s", text: "t" })).rejects.toThrow(/suppressed/);
    await m.send({ to: "ok@x.test", subject: "s", text: "t" });
    expect(inner.sent).toHaveLength(1);
  });
  it("webhook secret compare", () => {
    expect(webhookSecretOk("abc", "abc")).toBe(true);
    expect(webhookSecretOk("abd", "abc")).toBe(false);
    expect(webhookSecretOk("ab", "abc")).toBe(false);
    expect(webhookSecretOk(null, "abc")).toBe(false);
    expect(webhookSecretOk("abc", undefined)).toBe(false);
  });
});

describe("postmark adapter (fake fetch; never contacts Postmark)", () => {
  it("sends with the token header on the transactional stream", async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const p = new PostmarkMailSender("tok", "Ascend <no-reply@x.test>", async (url, init) => { calls.push({ url, headers: init.headers, body: init.body }); return { ok: true, status: 200, json: async () => ({ MessageID: "m1", ErrorCode: 0 }) }; });
    expect(await p.send({ to: "a@x.test", subject: "Hi", text: "Body" })).toEqual({ id: "m1" });
    expect(calls[0]!.headers["x-postmark-server-token"]).toBe("tok");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ From: "Ascend <no-reply@x.test>", To: "a@x.test", MessageStream: "outbound" });
  });
  it("throws on provider error and never claims success", async () => {
    const p = new PostmarkMailSender("tok", "f@x.test", async () => ({ ok: false, status: 422, json: async () => ({ ErrorCode: 406, Message: "inactive" }) }));
    await expect(p.send({ to: "a@x.test", subject: "s", text: "t" })).rejects.toThrow(/422/);
  });
  it("fromEnv: null without token, requires MAIL_FROM with token", () => {
    expect(PostmarkMailSender.fromEnv({})).toBeNull();
    expect(() => PostmarkMailSender.fromEnv({ POSTMARK_SERVER_TOKEN: "t" })).toThrow(/MAIL_FROM/);
    expect(PostmarkMailSender.fromEnv({ POSTMARK_SERVER_TOKEN: "t", MAIL_FROM: "f@x.test" })?.name).toBe("postmark");
  });
});

describe("SPF/DKIM/DMARC evaluation", () => {
  const key = "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC1234567890abcdef";
  it("a healthy setup is ready", () => {
    const r = evaluateDomainAuth({ spf: ["v=spf1 include:spf.mtasv.net -all"], dkim: { pm: [key] }, dmarc: ["v=DMARC1; p=quarantine; rua=mailto:d@x.test"], providerInclude: "spf.mtasv.net" });
    expect(r.ready).toBe(true);
  });
  it("flags the real failure modes", () => {
    const codes = (i: Parameters<typeof evaluateDomainAuth>[0]) => evaluateDomainAuth(i).findings.map((f) => f.code);
    expect(codes({ spf: [], dkim: {}, dmarc: [] })).toEqual(expect.arrayContaining(["spf_missing", "dkim_missing", "dmarc_missing"]));
    expect(codes({ spf: ["v=spf1 -all", "v=spf1 ~all"], dkim: { a: [key] }, dmarc: ["v=DMARC1; p=none"] })).toEqual(expect.arrayContaining(["spf_multiple", "dmarc_monitor", "dmarc_no_reports"]));
    expect(codes({ spf: ["v=spf1 +all"], dkim: { a: [key] }, dmarc: ["v=DMARC1; p=reject; rua=mailto:a@b.c"] })).toContain("spf_open");
    expect(codes({ spf: ["v=spf1 include:other.test -all"], dkim: { a: [key] }, dmarc: ["v=DMARC1; p=reject; rua=mailto:a@b.c"], providerInclude: "spf.mtasv.net" })).toContain("spf_provider");
    expect(evaluateDomainAuth({ spf: ["v=spf1 -all"], dkim: { a: ["v=DKIM1; p="] }, dmarc: ["v=DMARC1; p=reject"] }).ready).toBe(false);
  });
});
