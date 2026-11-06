import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import { AppError, configureEngine, createOrg, enableFrontDesk, MockModelProvider, ModelRouter, stopBoss, ToolRegistry, addFrontDeskSlots, listAvailability } from "@wos/core";
import { frontDeskTools } from "../../../packages/core/src/tools/front-desk";
import { resetDb, seedUser } from "../../../packages/db/test/helpers";
import { clientIp, publicErrorResponse, readJsonBody, PUBLIC_MAX_BODY_BYTES } from "../src/server/public-api";
import { POST as book } from "../src/app/api/front-desk/[token]/bookings/route";
import { GET as availability } from "../src/app/api/front-desk/[token]/availability/route";

const h = (xff?: string, real?: string) => new Headers({ ...(xff ? { "x-forwarded-for": xff } : {}), ...(real ? { "x-real-ip": real } : {}) });

describe("clientIp", () => {
  afterEach(() => { delete process.env.WOS_TRUSTED_PROXY_HOPS; });
  it("ignores the caller-supplied left side of X-Forwarded-For", () => {
    // Attacker sends "1.1.1.1"; Render appends the real address.
    expect(clientIp(h("1.1.1.1, 203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIp(h("6.6.6.6, 5.5.5.5, 203.0.113.9"))).toBe("203.0.113.9");
  });
  it("honours the configured number of proxies", () => {
    process.env.WOS_TRUSTED_PROXY_HOPS = "2"; // e.g. Cloudflare in front of Render
    expect(clientIp(h("1.1.1.1, 198.51.100.4, 172.16.0.1"))).toBe("198.51.100.4");
    expect(clientIp(h("198.51.100.4"))).toBe("198.51.100.4");
  });
  it("falls back safely", () => {
    expect(clientIp(h(undefined, "192.0.2.7"))).toBe("192.0.2.7");
    expect(clientIp(h())).toBe("unknown");
    process.env.WOS_TRUSTED_PROXY_HOPS = "0";
    expect(clientIp(h("1.1.1.1, 2.2.2.2"))).toBe("unknown");
  });
});

describe("readJsonBody", () => {
  const req = (body: string, len?: number) => new Request("http://x/", { method: "POST", body, headers: len ? { "content-length": String(len) } : {} });
  it("refuses oversized bodies, by header and by actual size", async () => {
    expect(((await readJsonBody(req("{}", PUBLIC_MAX_BODY_BYTES + 1))) as Response).status).toBe(413);
    expect(((await readJsonBody(req(JSON.stringify({ x: "a".repeat(PUBLIC_MAX_BODY_BYTES) })))) as Response).status).toBe(413);
  });
  it("refuses non-objects and bad JSON", async () => {
    for (const b of ["nope", "[1,2]", "null", "3"]) expect(((await readJsonBody(req(b))) as Response).status).toBe(400);
    expect(await readJsonBody(req('{"a":1}'))).toEqual({ a: 1 });
  });
});

describe("publicErrorResponse", () => {
  it("shows typed messages, hides everything else behind a generic 500", async () => {
    const typed = publicErrorResponse(new AppError("RATE_LIMITED", "Too many booking attempts."), "t");
    expect(typed.status).toBe(429);
    expect(await typed.json()).toMatchObject({ error: "Too many booking attempts." });
    const leaky = publicErrorResponse(new Error('relation "front_desk_slots" does not exist at db.internal:5432'), "t");
    expect(leaky.status).toBe(500);
    const body = JSON.stringify(await leaky.json());
    expect(body).not.toMatch(/front_desk_slots|db\.internal|relation/);
  });
});

describe("public booking routes", () => {
  let token: string;
  const params = () => ({ params: Promise.resolve({ token }) });
  beforeEach(async () => {
    await resetDb();
    await seedUser("owner", "owner@example.test");
    configureEngine({ router: new ModelRouter([new MockModelProvider(() => ({}))], "mock"), tools: new ToolRegistry().register(...frontDeskTools()) });
    const orgId = (await createOrg({ actorUserId: "owner", name: "Desk Co" })).orgId;
    const ch = await enableFrontDesk({ actorUserId: "owner", orgId, displayName: "Desk" });
    token = ch.publicToken;
    const s = new Date(Date.now() + 86_400_000);
    await addFrontDeskSlots({ actorUserId: "owner", orgId, channelId: ch.channelId, slots: [{ startsAt: s, endsAt: new Date(s.getTime() + 3_600_000), capacity: 5 }] });
  });
  afterAll(async () => { await stopBoss(); await closePool(); });

  it("a spoofed X-Forwarded-For can't reset the rate limit", async () => {
    let limited = false;
    // 20 per clock minute; 41 attempts guarantee a refusal even if the run crosses one minute boundary.
    for (let i = 0; i < 41 && !limited; i++) {
      const res = await book(new Request("http://x/", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${i}, 203.0.113.50` }, // new fake IP each time, same real one
        body: JSON.stringify({ slotId: "00000000-0000-4000-8000-000000000000", customerName: "X", customerEmail: `x${i}@example.test`, disclosureAck: true }),
      }), params());
      limited = res.status === 429;
    }
    expect(limited).toBe(true);
  });

  it("a string 'false' doesn't count as acknowledging the disclosure for AI agents", async () => {
    const slotId = (await listAvailability(token, new Date(), new Date(Date.now() + 7 * 86_400_000))).slots[0]!.id;
    const res = await book(new Request("http://x/", {
      method: "POST", headers: { "x-forwarded-for": "203.0.113.60" },
      body: JSON.stringify({ slotId, requesterKind: "ai_agent", agentName: "Bot", agentProvider: "Acme", disclosureAck: "false", customerName: "X", customerEmail: "x@example.test" }),
    }), params());
    expect(res.status).toBe(400);
  });

  it("availability refuses huge or backwards ranges, and unknown links get 404", async () => {
    const q = (from: string, to: string) => availability(new Request(`http://x/?from=${from}&to=${to}`), params());
    expect((await q("2026-01-01", "2027-01-01")).status).toBe(400);
    expect((await q("2026-02-01", "2026-01-01")).status).toBe(400);
    token = "not-a-real-token-at-all";
    expect((await availability(new Request("http://x/"), params())).status).toBe(404);
  });

});
