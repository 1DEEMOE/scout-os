import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, contacts, withTenant } from "@wos/db";
import {
  createDeal,
  createOrg,
  getDeal,
  inviteMember,
  listPipeline,
  moveDeal,
  pipelineForecast,
  savePipelineConfig,
  stopBoss,
  updateDeal,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

const OWNER = "pl-owner";
const MEMBER = "pl-member";
const VIEWER = "pl-viewer";
const OUTSIDER = "pl-outsider";

let orgId: string;
let outsiderOrg: string;
let contactId: string;

beforeEach(async () => {
  await resetDb();
  for (const u of [OWNER, MEMBER, VIEWER, OUTSIDER]) await seedUser(u, `${u}@example.test`);
  orgId = (await createOrg({ actorUserId: OWNER, name: "Pipeline Co" })).orgId;
  outsiderOrg = (await createOrg({ actorUserId: OUTSIDER, name: "Other Co" })).orgId;
  await inviteMember({ actorUserId: OWNER, orgId, email: `${MEMBER}@example.test`, role: "member" });
  await inviteMember({ actorUserId: OWNER, orgId, email: `${VIEWER}@example.test`, role: "viewer" });
  contactId = await withTenant(orgId, async (tx) => {
    const [row] = await tx.insert(contacts).values({ tenantId: orgId, name: "Ada", email: "ada@acme.com", source: "manual" }).returning({ id: contacts.id });
    return row!.id;
  });
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("native deal pipeline", () => {
  it("runs the lifecycle and keeps the weighted forecast in lockstep with the board", async () => {
    const { dealId } = await createDeal({ actorUserId: OWNER, orgId, contactId, name: "Roof job", amountCents: 1_000_000 });

    const lead = await getDeal({ actorUserId: MEMBER, orgId, dealId });
    expect(lead.stage).toBe("lead");
    expect(lead.probabilityBps).toBe(1000);
    expect(lead.weightedCents).toBe(100_000);
    expect(lead.contactName).toBe("Ada");

    let forecast = await pipelineForecast({ actorUserId: OWNER, orgId });
    expect(forecast.open).toEqual({ count: 1, totalCents: 1_000_000, weightedCents: 100_000 });
    expect(forecast.stages.find((s) => s.stage === "lead")).toMatchObject({ count: 1, totalCents: 1_000_000, weightedCents: 100_000 });

    await moveDeal({ actorUserId: MEMBER, orgId, dealId, stage: "quote_sent" });
    const quoted = await getDeal({ actorUserId: OWNER, orgId, dealId });
    expect(quoted.weightedCents).toBe(500_000);

    // Same-stage moves are idempotent (retries don't corrupt the record).
    await moveDeal({ actorUserId: MEMBER, orgId, dealId, stage: "quote_sent" });
    expect((await getDeal({ actorUserId: OWNER, orgId, dealId })).stage).toBe("quote_sent");

    await moveDeal({ actorUserId: MEMBER, orgId, dealId, stage: "won" });
    forecast = await pipelineForecast({ actorUserId: OWNER, orgId });
    expect(forecast.open.count).toBe(0);
    expect(forecast.wonThisMonth).toEqual({ count: 1, totalCents: 1_000_000 });
    expect(forecast.lostThisMonth.count).toBe(0);

    const board = await listPipeline({ actorUserId: OWNER, orgId });
    expect(board.map((d) => d.id)).toContain(dealId);
    const filtered = await listPipeline({ actorUserId: OWNER, orgId, stage: "won" });
    expect(filtered).toHaveLength(1);
  });

  it("tracks lost reasons and gates reopening to managers", async () => {
    const { dealId } = await createDeal({ actorUserId: OWNER, orgId, name: "Gutter job", amountCents: 200_000 });
    await moveDeal({ actorUserId: MEMBER, orgId, dealId, stage: "lost", lostReason: "price" });
    let deal = await getDeal({ actorUserId: OWNER, orgId, dealId });
    expect(deal.stage).toBe("lost");
    expect(deal.lostReason).toBe("price");
    expect(deal.closedAt).not.toBeNull();

    // Members can't reopen a closed deal; managers can.
    await expect(moveDeal({ actorUserId: MEMBER, orgId, dealId, stage: "lead" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await moveDeal({ actorUserId: OWNER, orgId, dealId, stage: "lead" });
    deal = await getDeal({ actorUserId: OWNER, orgId, dealId });
    expect(deal.stage).toBe("lead");
    expect(deal.closedAt).toBeNull();
    expect(deal.lostReason).toBeNull();

    // won ↔ lost directly is never allowed — reopen to an open stage first.
    await moveDeal({ actorUserId: OWNER, orgId, dealId, stage: "won" });
    await expect(moveDeal({ actorUserId: OWNER, orgId, dealId, stage: "lost" })).rejects.toMatchObject({ code: "CONFLICT" });

    // Closed deals can't be edited until reopened.
    await expect(updateDeal({ actorUserId: OWNER, orgId, dealId, name: "New name" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("enforces roles and tenant isolation", async () => {
    const { dealId } = await createDeal({ actorUserId: OWNER, orgId, name: "Fencing", amountCents: 50_000 });

    // Viewers read but never write.
    expect((await getDeal({ actorUserId: VIEWER, orgId, dealId })).name).toBe("Fencing");
    await expect(createDeal({ actorUserId: VIEWER, orgId, name: "Nope" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(moveDeal({ actorUserId: VIEWER, orgId, dealId, stage: "qualified" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateDeal({ actorUserId: VIEWER, orgId, dealId, name: "Nope" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Non-members get NOT_FOUND (no existence probe), and their own org's board is empty.
    await expect(listPipeline({ actorUserId: OUTSIDER, orgId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getDeal({ actorUserId: OUTSIDER, orgId, dealId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(moveDeal({ actorUserId: OUTSIDER, orgId, dealId, stage: "won" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await listPipeline({ actorUserId: OUTSIDER, orgId: outsiderOrg })).toEqual([]);
  });

  it("validates every writable field", async () => {
    await expect(createDeal({ actorUserId: OWNER, orgId, name: "   " })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createDeal({ actorUserId: OWNER, orgId, name: "X", amountCents: -1 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createDeal({ actorUserId: OWNER, orgId, name: "X", amountCents: 1.5 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createDeal({ actorUserId: OWNER, orgId, name: "X", expectedClose: "12/01/2026" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createDeal({ actorUserId: OWNER, orgId, name: "X", contactId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createDeal({ actorUserId: OWNER, orgId, name: "X", ownerUserId: OUTSIDER })).rejects.toMatchObject({ code: "VALIDATION" });
    // A new deal must start OPEN: closing at creation is not a thing.
    await expect(createDeal({ actorUserId: OWNER, orgId, name: "X", stage: "won" as "lead" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("lets managers tune open-stage probabilities and rejects bad config", async () => {
    const { dealId } = await createDeal({ actorUserId: OWNER, orgId, name: "Tune me", amountCents: 200_000 });
    expect((await getDeal({ actorUserId: OWNER, orgId, dealId })).weightedCents).toBe(20_000); // default 10%

    await expect(savePipelineConfig({ actorUserId: MEMBER, orgId, probabilityBps: { lead: 5000 } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await savePipelineConfig({ actorUserId: OWNER, orgId, probabilityBps: { lead: 5000 } });
    expect((await getDeal({ actorUserId: OWNER, orgId, dealId })).weightedCents).toBe(100_000);

    // Unknown stages (closed stages are facts, not tunable) and out-of-range weights are refused.
    await expect(savePipelineConfig({ actorUserId: OWNER, orgId, probabilityBps: { won: 5000 } as never })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(savePipelineConfig({ actorUserId: OWNER, orgId, probabilityBps: { lead: 10_001 } })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
