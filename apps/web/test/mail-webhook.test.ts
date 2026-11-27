import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemorySuppressionStore, setPlatformSuppressionStoreForTests } from "@wos/core";
import { POST } from "../src/app/api/webhooks/mail/[provider]/route";

const SECRET = "test_mail_webhook_secret";
const ORIGINAL = process.env.MAIL_WEBHOOK_SECRET;

let store: InMemorySuppressionStore;

beforeEach(() => {
  process.env.MAIL_WEBHOOK_SECRET = SECRET;
  store = new InMemorySuppressionStore();
  setPlatformSuppressionStoreForTests(store);
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MAIL_WEBHOOK_SECRET;
  else process.env.MAIL_WEBHOOK_SECRET = ORIGINAL;
  setPlatformSuppressionStoreForTests(undefined);
});

function hook(body: unknown, opts: { headerSecret?: string | null; basicSecret?: string; provider?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.headerSecret) headers["x-mail-webhook-secret"] = opts.headerSecret;
  if (opts.basicSecret) headers.authorization = `Basic ${Buffer.from(`webhook:${opts.basicSecret}`).toString("base64")}`;
  return POST(new Request(`https://app.example.com/api/webhooks/mail/${opts.provider ?? "postmark"}`, { method: "POST", headers, body: JSON.stringify(body) }), {
    params: Promise.resolve({ provider: opts.provider ?? "postmark" }),
  });
}

describe("platform mail webhook", () => {
  it("suppresses a hard bounce immediately (header secret)", async () => {
    const res = await hook({ RecordType: "Bounce", Type: "HardBounce", Email: "Dead@Example.com" }, { headerSecret: SECRET });
    expect(res.status).toBe(200);
    expect(await store.isSuppressed("dead@example.com")).toBe(true);
  });

  it("suppresses a spam complaint via basic-auth secret", async () => {
    const res = await hook({ RecordType: "SpamComplaint", Type: "SpamComplaint", Email: "angry@example.com" }, { basicSecret: SECRET });
    expect(res.status).toBe(200);
    expect(await store.isSuppressed("angry@example.com")).toBe(true);
  });

  it("suppresses only after the third soft bounce", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await hook({ RecordType: "Bounce", Type: "Transient", Email: "flaky@example.com" }, { headerSecret: SECRET });
      expect(res.status).toBe(200);
      expect(await store.isSuppressed("flaky@example.com")).toBe(false);
    }
    await hook({ RecordType: "Bounce", Type: "Transient", Email: "flaky@example.com" }, { headerSecret: SECRET });
    expect(await store.isSuppressed("flaky@example.com")).toBe(true);
  });

  it("rejects a wrong or missing secret with 403, and stays dark with no secret configured", async () => {
    expect((await hook({ RecordType: "Bounce", Type: "HardBounce", Email: "a@b.c" }, { headerSecret: "wrong" })).status).toBe(403);
    expect((await hook({ RecordType: "Bounce", Type: "HardBounce", Email: "a@b.c" })).status).toBe(403);
    delete process.env.MAIL_WEBHOOK_SECRET;
    expect((await hook({ RecordType: "Bounce", Type: "HardBounce", Email: "a@b.c" }, { headerSecret: SECRET })).status).toBe(404);
    expect(store.suppressed.size).toBe(0);
  });

  it("ignores non-suppression events and unknown providers", async () => {
    expect((await hook({ RecordType: "Open", Email: "a@b.c" }, { headerSecret: SECRET })).status).toBe(202);
    expect((await hook({ hello: "world" }, { headerSecret: SECRET })).status).toBe(202);
    expect((await hook({}, { headerSecret: SECRET, provider: "ses" })).status).toBe(404);
  });

  it("rejects malformed JSON and oversized bodies", async () => {
    const bad = await POST(new Request("https://app.example.com/api/webhooks/mail/postmark", { method: "POST", headers: { "x-mail-webhook-secret": SECRET }, body: "{nope" }), {
      params: Promise.resolve({ provider: "postmark" }),
    });
    expect(bad.status).toBe(400);
    const big = await POST(
      new Request("https://app.example.com/api/webhooks/mail/postmark", { method: "POST", headers: { "x-mail-webhook-secret": SECRET, "content-length": "999999" }, body: "{}" }),
      { params: Promise.resolve({ provider: "postmark" }) },
    );
    expect(big.status).toBe(413);
  });
});
