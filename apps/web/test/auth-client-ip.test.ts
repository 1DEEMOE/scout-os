import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import { POST } from "../src/app/api/auth/[...all]/route";
import { CLIENT_IP_HEADER, withResolvedClientIp } from "../src/server/public-api";
import { ownerQuery, resetDb } from "../../../packages/db/test/helpers";

const BASE = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

describe("trusted client IP for auth", () => {
  it("drops a spoofed header and takes the entry our proxy appended", async () => {
    process.env.WOS_TRUSTED_PROXY_HOPS = "1";
    const req = new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.9", [CLIENT_IP_HEADER]: "9.9.9.9", "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    const out = withResolvedClientIp(req);
    expect(out.headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
    expect(await out.json()).toEqual({ a: 1 }); // body survives
    process.env.WOS_TRUSTED_PROXY_HOPS = "2"; // CDN in front of Render
    expect(withResolvedClientIp(new Request(BASE, { headers: { "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.0.0.1" } })).headers.get(CLIENT_IP_HEADER)).toBe("198.51.100.7");
    process.env.WOS_TRUSTED_PROXY_HOPS = "0"; // forwarded headers ignored
    expect(withResolvedClientIp(new Request(BASE, { headers: { "x-forwarded-for": "6.6.6.6", [CLIENT_IP_HEADER]: "6.6.6.6" } })).headers.get(CLIENT_IP_HEADER)).toBeNull();
    delete process.env.WOS_TRUSTED_PROXY_HOPS;
  });
});

describe("sign-in rate limit is per client, not one shared bucket", () => {
  beforeAll(async () => {
    await resetDb();
    await ownerQuery("DELETE FROM rate_limits");
    process.env.WOS_TRUSTED_PROXY_HOPS = "1";
  });
  afterAll(async () => {
    delete process.env.WOS_TRUSTED_PROXY_HOPS;
    await closePool();
  });

  const attempt = (xff: string) =>
    POST(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": xff, origin: BASE },
        body: JSON.stringify({ email: "nobody@example.test", password: "wrong-password-123" }),
      }),
    );

  it("an attacker who exhausts their limit doesn't lock out someone else, even with multi-entry X-Forwarded-For", async () => {
    const statuses: number[] = [];
    // The attacker rotates the spoofed left-most entry; our proxy's entry stays the same.
    for (let i = 0; i < 12; i++) statuses.push((await attempt(`10.0.0.${i}, 203.0.113.50`)).status);
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // A different real client is unaffected.
    expect((await attempt("192.0.2.1, 203.0.113.77")).status).not.toBe(429);
    // Sending our internal header directly doesn't help the attacker either.
    const spoof = await POST(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9, 203.0.113.50", [CLIENT_IP_HEADER]: "198.18.0.1", origin: BASE },
        body: JSON.stringify({ email: "nobody@example.test", password: "wrong-password-123" }),
      }),
    );
    expect(spoof.status).toBe(429);
  });
});
