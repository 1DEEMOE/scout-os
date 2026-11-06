import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import { stopBoss } from "@wos/core";
import { getAuth } from "../src/server/auth";
import { appRouter, createCaller } from "../src/server/root";
import { makeContext } from "../src/server/trpc";
import { resetDb, seedUser } from "../../../packages/db/test/helpers";

// Entitlement bypass through the real API (directive §17): an owner of an org
// on a plan without Scout calls every scout.* procedure directly. Hiding the
// buttons is not the control; the server must refuse.

const NIL = "00000000-0000-4000-8000-000000000000";
/** Opting out and reading contact rules must work on every plan. */
const ALWAYS_ALLOWED = new Set(["scout.suppress", "scout.contactRules"]);
let orgId: string;

const input = () => ({
  orgId, opportunityId: NIL, csv: "name,county,state\nA,Dallas,TX\n", reportDay: "2026-11-01", label: "probe", usageRights: "Our own customer records.",
  attest: true, evidence: "probe evidence", reason: "opt_out", basis: "existing_customer", answers: {}, email: "probe@example.test",
  profile: { vertical: "roofing", services: [], serviceArea: { states: ["TX"], counties: [], center: null } },
});

beforeAll(async () => {
  await resetDb();
  await seedUser("owner", "owner@example.test");
  orgId = (await createCaller(makeContext("owner")).org.create({ name: "Starter Co" })).orgId; // new orgs start on Starter
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

const scoutProcedures = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith("scout.")).sort();

describe("Scout API on a plan without Scout", () => {
  it("covers every Scout procedure", () => {
    expect(scoutProcedures.length).toBe(19);
  });

  it.each(scoutProcedures.filter((p) => !ALWAYS_ALLOWED.has(p)))("%s is refused with PAYMENT_REQUIRED", async (path) => {
    const [ns, fn] = path.split(".") as [string, string];
    const caller = createCaller(makeContext("owner")) as unknown as Record<string, Record<string, (i: unknown) => Promise<unknown>>>;
    await expect(caller[ns]![fn]!(input())).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });
  });

  it("opting someone out still works, so do-not-contact never depends on a plan", async () => {
    const caller = createCaller(makeContext("owner"));
    await caller.scout.suppress({ orgId, email: "Stop@Example.test", reason: "opt_out" });
    expect((await caller.scout.contactRules({ orgId })).suppressed.map((s) => s.value)).toEqual(["stop@example.test"]);
  });
});

describe("CSRF", () => {
  it("the session cookie is HttpOnly and SameSite=Lax, so cross-site POSTs carry no session", async () => {
    const res = await getAuth().api.signUpEmail({ body: { name: "C", email: "csrf@example.test", password: "a long enough password" }, asResponse: true });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/better-auth\.session_token=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });
});
