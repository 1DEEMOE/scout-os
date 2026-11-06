import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvalRequests, closePool, frontDeskBookings, tasks, withFrontDeskToken, withTenant } from "@wos/db";
import { createHash } from "node:crypto";
import {
  actionDigest,
  addFrontDeskSlots,
  approvalsForReview,
  configureEngine,
  createOrg,
  decideApproval,
  enableFrontDesk,
  FRONT_DESK_TOOL,
  listAvailability,
  listFrontDeskChannels,
  listFrontDeskSlots,
  rotateFrontDeskLink,
  setFrontDeskStatus,
  inviteMember,
  AppError,
  MockModelProvider,
  ModelRouter,
  requestBooking,
  runTask,
  stopBoss,
  ToolRegistry,
} from "../src/index";
import { frontDeskTools } from "../src/tools/front-desk";
import { MockLedger, mockTools } from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

const OWNER = "fd-owner";
let orgId: string;
let token: string;
let channelId: string;

beforeEach(async () => {
  await resetDb();
  await seedUser(OWNER, "fd@example.test");
  configureEngine({
    router: new ModelRouter([new MockModelProvider(() => ({}))], "mock"),
    tools: new ToolRegistry().register(...mockTools(new MockLedger()), ...frontDeskTools()),
  });
  orgId = (await createOrg({ actorUserId: OWNER, name: "Front Desk Co" })).orgId;
  const ch = await enableFrontDesk({ actorUserId: OWNER, orgId, displayName: "Main desk" });
  token = ch.publicToken;
  channelId = ch.channelId;
  const start = new Date(Date.now() + 86_400_000);
  const end = new Date(start.getTime() + 3_600_000);
  await addFrontDeskSlots({
    actorUserId: OWNER,
    orgId,
    channelId,
    slots: [{ startsAt: start, endsAt: end, capacity: 50 }],
  });
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("AI front desk", () => {
  it("lists availability with disclosure", async () => {
    const avail = await listAvailability(token, new Date(), new Date(Date.now() + 7 * 86_400_000));
    expect(avail.channel.disclosure.length).toBeGreaterThan(10);
    expect(avail.slots.length).toBe(1);
    expect(avail.slots[0]!.remaining).toBe(50);
  });

  it("requires agent identity for AI agents and always creates tier ≥2 approval", async () => {
    const avail = await listAvailability(token, new Date(), new Date(Date.now() + 7 * 86_400_000));
    const slotId = avail.slots[0]!.id;

    await expect(
      requestBooking({
        publicToken: token,
        slotId,
        requesterKind: "ai_agent",
        disclosureAck: true,
        customerName: "Alex",
        customerEmail: "alex@example.test",
        sourceIp: "1.2.3.4",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const booked = await requestBooking({
      publicToken: token,
      slotId,
      requesterKind: "ai_agent",
      agentName: "HelperBot",
      agentProvider: "example-ai",
      disclosureAck: true,
      customerName: "Alex",
      customerEmail: "alex@example.test",
      clientRef: "ref-1",
      sourceIp: "1.2.3.4",
    });
    expect(booked.approvalRequired).toBe(true);
    expect(booked.status).toBe("pending_approval");

    const [ap] = await withTenant(orgId, (tx) =>
      tx.select().from(approvalRequests).where(eq(approvalRequests.toolName, FRONT_DESK_TOOL)),
    );
    expect(ap!.tier).toBeGreaterThanOrEqual(2);

    const again = await requestBooking({
      publicToken: token,
      slotId,
      requesterKind: "ai_agent",
      agentName: "HelperBot",
      agentProvider: "example-ai",
      disclosureAck: true,
      customerName: "Alex",
      customerEmail: "alex@example.test",
      clientRef: "ref-1",
      sourceIp: "1.2.3.4",
    });
    expect(again.bookingId).toBe(booked.bookingId);
  });

  it("rate-limits abusive bursts", async () => {
    const avail = await listAvailability(token, new Date(), new Date(Date.now() + 7 * 86_400_000));
    const slotId = avail.slots[0]!.id;
    let limited = false;
    for (let i = 0; i < 41; i++) { // 41: still refused if the run crosses a minute boundary
      try {
        await requestBooking({
          publicToken: token,
          slotId,
          requesterKind: "person",
          disclosureAck: true,
          customerName: `Person ${i}`,
          customerEmail: `p${i}@example.test`,
          clientRef: `burst-${i}`,
          sourceIp: "9.9.9.9",
        });
      } catch (err) {
        if ((err as { code?: string }).code === "RATE_LIMITED") {
          limited = true;
          break;
        }
      }
    }
    expect(limited).toBe(true);
  });

  it("counts failed attempts too: bad slot ids can't dodge the limit, and denials are audited", async () => {
    let limitedAt = -1;
    for (let i = 0; i < 41; i++) {
      try {
        await requestBooking({
          publicToken: token,
          slotId: "00000000-0000-4000-8000-000000000000", // never exists: every attempt fails
          requesterKind: "person",
          disclosureAck: true,
          customerName: `Prober ${i}`,
          customerEmail: `probe${i}@example.test`,
          sourceIp: "7.7.7.7",
        });
      } catch (err) {
        if ((err as { code?: string }).code === "RATE_LIMITED") {
          limitedAt = i;
          break;
        }
      }
    }
    // 20 attempts per clock minute, failed or not: refused at attempt 21, or by 41 if the run crosses a minute boundary.
    expect(limitedAt).toBeGreaterThanOrEqual(20);
    expect(limitedAt).toBeLessThanOrEqual(40);
    const denied = await withTenant(orgId, async (tx) =>
      (await tx.raw.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'front_desk.rate_limited'`)).rows[0] as { n: number },
    );
    expect(denied.n).toBe(1); // only the first denial in a window is audited
  });

  it("booking links work without the admin connection (no god credential in the web process)", async () => {
    const saved = { a: process.env.DATABASE_URL_ADMIN, t: process.env.TEST_DATABASE_URL_ADMIN };
    delete process.env.DATABASE_URL_ADMIN;
    delete process.env.TEST_DATABASE_URL_ADMIN;
    try {
      const avail = await listAvailability(token, new Date(), new Date(Date.now() + 7 * 86_400_000));
      expect(avail.slots).toHaveLength(1);
      const booked = await requestBooking({
        publicToken: token, slotId: avail.slots[0]!.id, requesterKind: "person", disclosureAck: true,
        customerName: "No Admin", customerEmail: "noadmin@example.test", sourceIp: "198.51.100.1",
      });
      expect(booked.bookingId).toBeTruthy();
    } finally {
      if (saved.a) process.env.DATABASE_URL_ADMIN = saved.a;
      if (saved.t) process.env.TEST_DATABASE_URL_ADMIN = saved.t;
    }
  });

  it("the token-lookup policy reveals only the matching channel, and nothing else", async () => {
    await seedUser("other-owner", "other@example.test");
    const other = (await createOrg({ actorUserId: "other-owner", name: "Other Co" })).orgId;
    const otherCh = await enableFrontDesk({ actorUserId: "other-owner", orgId: other, displayName: "Other desk" });
    const hash = (t: string) => createHash("sha256").update(t).digest("hex");
    const seen = await withFrontDeskToken(hash(token), async (tx) => ({
      channels: (await tx.raw.query("SELECT id, tenant_id FROM front_desk_channels")).rows,
      slots: (await tx.raw.query("SELECT count(*)::int AS n FROM front_desk_slots")).rows[0],
      bookings: (await tx.raw.query("SELECT count(*)::int AS n FROM front_desk_bookings")).rows[0],
      orgs: (await tx.raw.query("SELECT count(*)::int AS n FROM organizations")).rows[0],
    }));
    expect(seen.channels).toEqual([{ id: channelId, tenant_id: orgId }]); // not the other org's channel
    expect(seen).toMatchObject({ slots: { n: 0 }, bookings: { n: 0 } });
    const none = await withFrontDeskToken(hash("a-token-nobody-has-0000"), async (tx) => (await tx.raw.query("SELECT id FROM front_desk_channels")).rows);
    expect(none).toEqual([]);
    // The policy is read-only: it can't be used to change a channel.
    const upd = await withFrontDeskToken(hash(token), async (tx) => (await tx.raw.query("UPDATE front_desk_channels SET display_name = 'pwned' RETURNING id")).rowCount);
    expect(upd).toBe(0);
    expect(otherCh.channelId).not.toBe(channelId);
  });

  it("owners can pause a desk (link answers not found) and resume it", async () => {
    await setFrontDeskStatus({ actorUserId: OWNER, orgId, channelId, status: "paused" });
    await expect(listAvailability(token, new Date(), new Date(Date.now() + 7 * 86_400_000))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await setFrontDeskStatus({ actorUserId: OWNER, orgId, channelId, status: "active" });
    expect((await listAvailability(token, new Date(), new Date(Date.now() + 7 * 86_400_000))).slots).toHaveLength(1);
  });

  it("rotating the link kills the old one at once and audits it as a credential change", async () => {
    const { publicToken } = await rotateFrontDeskLink({ actorUserId: OWNER, orgId, channelId });
    expect(publicToken).not.toBe(token);
    await expect(listAvailability(token, new Date(), new Date(Date.now() + 7 * 86_400_000))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listAvailability(publicToken, new Date(), new Date(Date.now() + 7 * 86_400_000))).slots).toHaveLength(1);
    const a = await withTenant(orgId, async (tx) => (await tx.raw.query(`SELECT tier FROM audit_events WHERE action = 'front_desk.rotate'`)).rows);
    expect(a).toEqual([{ tier: 4 }]);
  });

  it("members can't pause, rotate or enable; the channel list never exposes the token hash", async () => {
    await seedUser("fd-member", "fdm@example.test");
    await inviteMember({ actorUserId: OWNER, orgId, email: "fdm@example.test", role: "member" });
    const forbidden = (p: Promise<unknown>) => expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === "FORBIDDEN");
    await forbidden(setFrontDeskStatus({ actorUserId: "fd-member", orgId, channelId, status: "paused" }));
    await forbidden(rotateFrontDeskLink({ actorUserId: "fd-member", orgId, channelId }));
    await forbidden(enableFrontDesk({ actorUserId: "fd-member", orgId, displayName: "Sneaky" }));
    const channels = await listFrontDeskChannels({ actorUserId: "fd-member", orgId });
    expect(channels).toHaveLength(1);
    expect(JSON.stringify(channels)).not.toMatch(/token|[0-9a-f]{64}/i);
  });

  it("refuses slots in the past, too long, too far out or over capacity", async () => {
    const add = (startsAt: Date, endsAt: Date, capacity?: number) => addFrontDeskSlots({ actorUserId: OWNER, orgId, channelId, slots: [{ startsAt, endsAt, capacity }] });
    const h = 3_600_000;
    const soon = Date.now() + 2 * h;
    await expect(add(new Date(Date.now() - h), new Date(Date.now()))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(add(new Date(soon), new Date(soon + 13 * h))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(add(new Date(Date.now() + 400 * 86_400_000), new Date(Date.now() + 400 * 86_400_000 + h))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(add(new Date(soon), new Date(soon + h), 51)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(addFrontDeskSlots({ actorUserId: OWNER, orgId, channelId, slots: [] })).rejects.toMatchObject({ code: "VALIDATION" });
    await add(new Date(soon), new Date(soon + h), 3);
    const slots = await listFrontDeskSlots({ actorUserId: OWNER, orgId, channelId });
    expect(slots.map((x) => x.capacity)).toEqual([3, 50]);
  });

  it("stores the executor digest so approving a booking confirms it", async () => {
    const avail = await listAvailability(token, new Date(), new Date(Date.now() + 7 * 86_400_000));
    const slotId = avail.slots[0]!.id;
    const booked = await requestBooking({
      publicToken: token,
      slotId,
      requesterKind: "person",
      disclosureAck: true,
      customerName: "Wayne Cole",
      customerEmail: "wayne.cole@example.test",
      sourceIp: "10.0.0.2",
    });
    const [ap] = await withTenant(orgId, (tx) =>
      tx.select().from(approvalRequests).where(eq(approvalRequests.toolName, FRONT_DESK_TOOL)),
    );
    expect(ap).toBeTruthy();
    const expected = actionDigest({
      tenantId: orgId,
      taskId: ap!.taskId,
      agentId: ap!.agentId,
      step: 0,
      tool: FRONT_DESK_TOOL,
      args: { bookingId: booked.bookingId },
    });
    expect(ap!.actionDigest).toBe(expected);
    const [task] = await withTenant(orgId, (tx) => tx.select().from(tasks).where(eq(tasks.id, ap!.taskId)));
    const step = (task!.plan as { steps: Array<{ digest: string; args: unknown }> }).steps[0]!;
    expect(step.digest).toBe(expected);

    const review = await approvalsForReview({ actorUserId: OWNER, orgId });
    const card = review.open.find((r) => r.approval.id === ap!.id);
    expect(card?.requestedByName).toBe("Front desk: Wayne Cole");
    expect(card?.requestedByName).not.toBe("Former member");

    await decideApproval({ actorUserId: OWNER, orgId, approvalId: ap!.id, decision: "approve" });
    expect(await runTask(orgId, ap!.taskId)).toBe("COMPLETED");
    const [row] = await withTenant(orgId, (tx) =>
      tx.select().from(frontDeskBookings).where(eq(frontDeskBookings.id, booked.bookingId)),
    );
    expect(row!.status).toBe("confirmed");
  });

  it("still fails DIGEST_MISMATCH if the planned args change after approval", async () => {
    const avail = await listAvailability(token, new Date(), new Date(Date.now() + 7 * 86_400_000));
    const booked = await requestBooking({
      publicToken: token,
      slotId: avail.slots[0]!.id,
      requesterKind: "person",
      disclosureAck: true,
      customerName: "Pat Lee",
      customerEmail: "pat.lee@example.test",
      clientRef: "digest-tamper",
      sourceIp: "10.0.0.3",
    });
    const [ap] = await withTenant(orgId, (tx) => tx.select().from(approvalRequests));
    const [task] = await withTenant(orgId, (tx) => tx.select().from(tasks).where(eq(tasks.id, ap!.taskId)));
    const plan = task!.plan as { steps: Array<{ index: number; tool: string; args: unknown; tier: number; summary: string; digest: string; decision: string; approvalId?: string }> };
    plan.steps[0] = { ...plan.steps[0]!, args: { bookingId: crypto.randomUUID() } };
    await withTenant(orgId, (tx) => tx.update(tasks).set({ plan }).where(eq(tasks.id, task!.id)));
    await decideApproval({ actorUserId: OWNER, orgId, approvalId: ap!.id, decision: "approve" });
    expect(await runTask(orgId, ap!.taskId)).toBe("FAILED");
    const [failed] = await withTenant(orgId, (tx) => tx.select().from(tasks).where(eq(tasks.id, ap!.taskId)));
    expect(failed!.error).toMatchObject({ code: "DIGEST_MISMATCH" });
    const [row] = await withTenant(orgId, (tx) =>
      tx.select().from(frontDeskBookings).where(eq(frontDeskBookings.id, booked.bookingId)),
    );
    expect(row!.status).toBe("pending_approval");
  });

  it("labels an AI-assistant booking as Front desk: name (AI assistant: …)", async () => {
    const avail = await listAvailability(token, new Date(), new Date(Date.now() + 7 * 86_400_000));
    await requestBooking({
      publicToken: token,
      slotId: avail.slots[0]!.id,
      requesterKind: "ai_agent",
      agentName: "Ava",
      agentProvider: "Homeowner Helper",
      disclosureAck: true,
      customerName: "Denise Harper",
      customerEmail: "denise.harper@example.test",
      sourceIp: "10.0.0.4",
    });
    const review = await approvalsForReview({ actorUserId: OWNER, orgId });
    const card = review.open.find((r) => r.requestedByName.includes("Denise Harper"));
    expect(card?.requestedByName).toBe("Front desk: Denise Harper (AI assistant: Ava)");
  });
});
