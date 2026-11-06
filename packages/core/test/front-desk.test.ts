import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvalRequests, closePool, frontDeskBookings, tasks, withTenant } from "@wos/db";
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
