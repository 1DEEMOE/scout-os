import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool, memoryRecords, withTenant, type Tx } from "@wos/db";
import {
  SmsRegistrationBlocked, approveAllTemplates, attestSmsRegistration, createOrg, findLeadByExternalKey, ingestLead, inviteMember,
  quickstartBusiness, recordSmsConsent, resetMockSms, resetSmsPorts, sendSmsGuarded, setSmsPortForTests, smsRegistrationCheck, type SmsPort,
} from "../src/index";
import { fulfillSpeedApproval } from "../src/speed/service";
import { resetDb, seedUser } from "../../db/test/helpers";

const NOON_CHICAGO = new Date("2026-06-15T17:00:00Z");
const LINE_A = "+15559876543"; // the number customers contacted
const LINE_B = "+15551230000";
const CUSTOMER = "+13125550100";

let orgId: string;
let sent: { to: string; body: string }[];
/** A LIVE-shaped port (mock:false). The shared fakes in other tests are mock:true, which is exempt. */
const livePort: SmsPort = { mock: false, async send(m) { sent.push({ to: m.to, body: m.body }); return { sid: `SM_${sent.length}`, mock: false }; } };

beforeEach(async () => {
  await resetDb(); resetMockSms(); resetSmsPorts(); sent = [];
  delete process.env.TWILIO_FROM_NUMBER; // no platform default number
  setSmsPortForTests(livePort);
  await seedUser("owner", "owner@example.test"); await seedUser("member", "member@example.test");
  orgId = (await createOrg({ actorUserId: "owner", name: "Northside Nails" })).orgId;
  await quickstartBusiness({ actorUserId: "owner", orgId, name: "Northside Nails", industry: "nail_salon", timezone: "America/Chicago" });
  await approveAllTemplates({ actorUserId: "owner", orgId });
});
afterEach(() => setSmsPortForTests(undefined));
afterAll(async () => { await closePool(); });

const tx = <T,>(fn: (t: Tx) => Promise<T>) => withTenant(orgId, fn);
const lead = (key: string, extra: Record<string, unknown> = {}) =>
  ingestLead({ actorUserId: "owner", orgId, source: "sms", externalKey: key, name: "Sam", phone: CUSTOMER, purpose: "first_response", inboundInitiated: true, smsFrom: LINE_A, now: NOON_CHICAGO, businessName: "Northside Nails", ...extra });
const register = (status: "approved" | "pending" | "rejected" | "not_started", phone = LINE_A) => attestSmsRegistration({ actorUserId: "owner", orgId, phone, status });

describe("SMS carrier registration: fail closed on a live port", () => {
  it("blocks when nothing is recorded (unverifiable) and sends nothing", async () => {
    const l = await lead("k1");
    expect(l.outcome).toBe("blocked");
    expect(l.blockReason).toBe("sms_registration_unverified");
    expect(sent).toHaveLength(0);
  });

  it.each(["pending", "rejected", "not_started"] as const)("blocks when registration is %s", async (status) => {
    await register(status);
    const l = await lead(`k-${status}`);
    expect(l.outcome).toBe("blocked");
    expect(l.blockReason).toBe(`sms_registration_${status}`);
    expect(sent).toHaveLength(0);
  });

  it("sends once registration is approved, and remembers the number the customer contacted", async () => {
    await register("approved");
    const l = await lead("k2");
    expect(l.outcome).toBe("sent");
    expect(l.smsFrom).toBe(LINE_A);
    expect(sent).toHaveLength(1);
  });

  it("registration is per number: approval for one line does not cover another", async () => {
    await register("approved", LINE_A);
    const l = await lead("k3", { smsFrom: LINE_B });
    expect(l.outcome).toBe("blocked");
    expect(l.blockReason).toBe("sms_registration_unverified");
    expect(sent).toHaveLength(0);
  });

  it("registration is per tenant: another workspace's approval is invisible", async () => {
    await register("approved");
    await seedUser("owner2", "owner2@example.test");
    const org2 = (await createOrg({ actorUserId: "owner2", name: "Other Salon" })).orgId;
    const check = await withTenant(org2, (t) => smsRegistrationCheck(t, org2, LINE_A));
    expect(check).toMatchObject({ ok: false, reason: "sms_registration_unverified" });
  });

  it("a corrupt registration record fails closed", async () => {
    await tx((t) => t.insert(memoryRecords).values({ tenantId: orgId, layer: "org", scopeRef: `speed:smsreg:${LINE_A}`, content: "{not json", trust: "user", createdByUser: "owner" }));
    expect((await lead("k4")).blockReason).toBe("sms_registration_unverified");
    await tx((t) => t.delete(memoryRecords).where(eq(memoryRecords.scopeRef, `speed:smsreg:${LINE_A}`)));
    await tx((t) => t.insert(memoryRecords).values({ tenantId: orgId, layer: "org", scopeRef: `speed:smsreg:${LINE_A}`, content: JSON.stringify({ phone: LINE_A, status: "totally-approved" }), trust: "user", createdByUser: "owner" }));
    expect((await lead("k5")).blockReason).toBe("sms_registration_unverified");
    expect(sent).toHaveLength(0);
  });

  it("a managed number's own record is authoritative over an owner attestation", async () => {
    await register("approved");
    await tx((t) => t.insert(memoryRecords).values({
      tenantId: orgId, layer: "org", scopeRef: "speed:managed-number", trust: "verified", createdByUser: "system:managed-number",
      content: JSON.stringify({ tenantId: orgId, phone: LINE_A, status: "active", a2p: "pending", mock: false, updatedAt: "2026-06-15T00:00:00Z" }),
    }));
    const l = await lead("k6");
    expect(l.blockReason).toBe("sms_registration_pending");
    expect(sent).toHaveLength(0);
  });

  it("the labelled mock port is exempt: nothing leaves, so registration is irrelevant", async () => {
    setSmsPortForTests({ mock: true, async send() { return { sid: "SM_mock", mock: true }; } });
    expect((await lead("k7")).outcome).toBe("sent");
  });
});

describe("SMS carrier registration: every send path", () => {
  it("approved custom replies are re-checked at approval time and send from the contacted number", async () => {
    // Approved replies need recorded consent today (see note in the PR): record it so registration is what is under test.
    await recordSmsConsent({ actorUserId: "owner", orgId, phone: CUSTOMER, evidence: "Customer texted the shop first, 2026-06-15" });
    await register("pending");
    const queued = await lead("c1", { customBody: "Hi Sam, we can come Tuesday." });
    expect(queued.outcome).toBe("queued");
    await tx((t) => fulfillSpeedApproval(t, orgId, queued.id, NOON_CHICAGO));
    let after = await tx((t) => findLeadByExternalKey(t, "c1"));
    expect(after?.outcome).toBe("blocked");
    expect(after?.blockReason).toBe("sms_registration_pending");
    expect(sent).toHaveLength(0);

    // Registration approved later: a retry now goes out. It can only pass if the approval path used the
    // number the customer contacted. The old code sent with NO from-number (platform default), which
    // would be "unverified" here because no default is configured.
    await register("approved");
    const q2 = await lead("c2", { customBody: "Hi Sam, Tuesday works." });
    await tx((t) => fulfillSpeedApproval(t, orgId, q2.id, NOON_CHICAGO));
    after = await tx((t) => findLeadByExternalKey(t, "c2"));
    expect(after?.outcome).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("the guarded send itself refuses when registration is missing, even if called directly", async () => {
    await expect(tx((t) => sendSmsGuarded(t, orgId, LINE_A, { to: CUSTOMER, body: "x", idempotencyKey: "i1" }))).rejects.toBeInstanceOf(SmsRegistrationBlocked);
    expect(sent).toHaveLength(0);
    await register("approved");
    await tx((t) => sendSmsGuarded(t, orgId, LINE_A, { to: CUSTOMER, body: "x", idempotencyKey: "i2" }));
    expect(sent).toHaveLength(1);
  });

  it("no other code can reach the SMS port: only sms-registration.ts may call send on it", () => {
    const roots = [join(__dirname, "../src"), join(__dirname, "../../../apps/web/src")];
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
    roots.forEach(walk);
    const offenders = files.filter((f) => {
      if (/speed\/(sms-registration|sms)\.ts$/.test(f)) return false;
      const src = readFileSync(f, "utf8");
      return /smsPortForSend\([^)]*\)\s*\.send\(/.test(src) || /twilioSmsPort\(/.test(src.replace(/export \{[^}]*\}/g, "")) || /\bmockSmsPort\(\)\.send\(/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});

describe("recording registration", () => {
  it("only owners and admins may attest; members, bad numbers and bad statuses are rejected", async () => {
    await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
    await expect(attestSmsRegistration({ actorUserId: "member", orgId, phone: LINE_A, status: "approved" })).rejects.toThrow();
    await expect(attestSmsRegistration({ actorUserId: "owner", orgId, phone: "123", status: "approved" })).rejects.toThrow(/phone number/i);
    await expect(attestSmsRegistration({ actorUserId: "owner", orgId, phone: LINE_A, status: "yes" as never })).rejects.toThrow(/status/i);
    expect((await withTenant(orgId, (t) => smsRegistrationCheck(t, orgId, LINE_A))).ok).toBe(false);
  });
});
