import Stripe from "stripe";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import { stopBoss } from "@wos/core";
import { createCaller } from "../src/server/root";
import { makeContext } from "../src/server/trpc";
import { POST } from "../src/app/api/webhooks/stripe/route";
import { resetDb, seedUser } from "../../../packages/db/test/helpers";

const as = (userId: string | null) => createCaller(makeContext(userId));
let orgA: string;

beforeEach(async () => {
  await resetDb();
  for (const u of ["alice", "mike", "bob"]) await seedUser(u, `${u}@example.test`);
  orgA = (await as("alice").org.create({ name: "A" })).orgId;
  await as("bob").org.create({ name: "B" });
  await as("alice").org.invite({ orgId: orgA, email: "mike@example.test", role: "member" });
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("billing endpoints", () => {
  it("enforce authentication, owner-only budget and checkout, and tenant isolation", async () => {
    for (const c of [() => as(null).billing.usage({ orgId: orgA }), () => as(null).billing.setBudget({ orgId: orgA, budgetCents: 1 }), () => as(null).billing.checkout({ orgId: orgA }), () => as(null).billing.subscription({ orgId: orgA })]) {
      await expect(c()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    await expect(as("mike").billing.setBudget({ orgId: orgA, budgetCents: 999 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("mike").billing.checkout({ orgId: orgA })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await as("alice").billing.setBudget({ orgId: orgA, budgetCents: 2500 })).toEqual({ budgetMicros: 25_000_000 });
    expect((await as("mike").billing.usage({ orgId: orgA })).budgetMicros).toBe(25_000_000);
    await expect(as("bob").billing.usage({ orgId: orgA })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("Stripe webhook route", () => {
  it("verifies the raw body: 200 when signed, 400 when not", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_route_test";
    const body = JSON.stringify({ id: "evt_r1", object: "event", type: "ping.unhandled", data: { object: {} } });
    const sig = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_route_test" });
    const ok = await POST(new Request("http://x/api/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": sig } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "ignored", type: "ping.unhandled" });
    const bad = await POST(new Request("http://x/api/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": "t=1,v1=00" } }));
    expect(bad.status).toBe(400);
  });
});
