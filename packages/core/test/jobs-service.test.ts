import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@wos/db";
import {
  advanceJob,
  assignCrew,
  cancelJob,
  confirmJobsPricing,
  createJob,
  createOrg,
  dispatchJob,
  getJob,
  inviteMember,
  jobFormConfig,
  jobsTools,
  listJobs,
  prepareEstimate,
  recordJobOutcome,
  requestEstimateSend,
  returnEstimateToDraft,
  saveJobsBusinessFields,
  scheduleJob,
  stopBoss,
  writePackId,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

let orgId: string;

const MOVING_ANSWERS = {
  move_type: "local",
  home_size: "2br",
  origin_address: "1 Oak St",
  dest_address: "2 Pine Ave",
  move_date: "2026-12-01",
  crew_size: 3,
  est_hours: 5,
};

async function makeJob(email = "ada@example.test") {
  return createJob({ actorUserId: "owner", orgId, customerName: "Ada", customerEmail: email, answers: { ...MOVING_ANSWERS } });
}

/** Clears both send blockers: example prices (owner confirms) and missing business fields. */
async function unlockSending() {
  await confirmJobsPricing({ actorUserId: "owner", orgId });
  await saveJobsBusinessFields({ actorUserId: "owner", orgId, fields: { business_address: "9 Depot Rd" } });
}

beforeEach(async () => {
  await resetDb();
  for (const u of ["owner", "member", "outsider"]) await seedUser(u, `${u}@example.test`);
  orgId = (await createOrg({ actorUserId: "owner", name: "Move Co" })).orgId;
  await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
  await withTenant(orgId, (tx) => writePackId(tx, orgId, "moving", "owner"));
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("jobs workspace (elite pack, interim store, real DB)", () => {
  it("runs the full pipeline: intake → estimate → approval → sent → booked → dispatched → done", async () => {
    const { jobId } = await makeJob();

    const created = await getJob({ actorUserId: "owner", orgId, jobId });
    expect(created.status).toBe("inquiry");
    expect(created.jurisdiction).toBe("intrastate"); // local move

    const { estimate } = await prepareEstimate({ actorUserId: "owner", orgId, jobId });
    expect(estimate.lines.length).toBeGreaterThan(0);
    expect(estimate.totalCents).toBeGreaterThan(0);
    // Example prices block sending until the owner confirms.
    expect(estimate.blockedReasons.join(" ")).toMatch(/example/i);

    await unlockSending();

    const req = await requestEstimateSend({ actorUserId: "owner", orgId, jobId });
    expect(req.approvalId).toBeTruthy();
    expect(req.tier).toBeGreaterThanOrEqual(2);
    expect((await getJob({ actorUserId: "owner", orgId, jobId })).status).toBe("approval_pending");

    // Simulate the executor running the approved step (mock mail sender).
    const tool = jobsTools()[0]!;
    const out = await tool.execute({ tenantId: orgId, taskId: "task-1", agentId: "agent-1", idempotencyKey: "k1" }, { jobId });
    expect(out).toMatchObject({ sent: true, mock: true, jobId });
    expect((await getJob({ actorUserId: "owner", orgId, jobId })).status).toBe("estimate_sent");

    // Tool is idempotent on crash-retry.
    const again = (await tool.execute({ tenantId: orgId, taskId: "task-1", agentId: "agent-1", idempotencyKey: "k1" }, { jobId })) as { sent: boolean };
    expect(again.sent).toBe(true);

    await recordJobOutcome({ actorUserId: "owner", orgId, jobId, outcome: "booked" });
    await scheduleJob({ actorUserId: "owner", orgId, jobId, scheduledFor: new Date("2026-12-01T09:00:00Z") });
    await assignCrew({ actorUserId: "owner", orgId, jobId, memberIds: ["owner", "member"] });
    await dispatchJob({ actorUserId: "owner", orgId, jobId });
    expect((await getJob({ actorUserId: "owner", orgId, jobId })).status).toBe("dispatched");

    // A crew member (not a manager) advances the work.
    await advanceJob({ actorUserId: "member", orgId, jobId, to: "in_progress" });
    const done = await advanceJob({ actorUserId: "member", orgId, jobId, to: "done" });
    expect(done.status).toBe("done");
  });

  it("refuses to send while prices are examples or business fields are missing", async () => {
    const { jobId } = await makeJob();
    await prepareEstimate({ actorUserId: "owner", orgId, jobId });
    await expect(requestEstimateSend({ actorUserId: "owner", orgId, jobId })).rejects.toMatchObject({ code: "CONFLICT" });

    await confirmJobsPricing({ actorUserId: "owner", orgId });
    // Still blocked: business address missing.
    await expect(requestEstimateSend({ actorUserId: "owner", orgId, jobId })).rejects.toMatchObject({ code: "CONFLICT" });

    await saveJobsBusinessFields({ actorUserId: "owner", orgId, fields: { business_address: "9 Depot Rd" } });
    const req = await requestEstimateSend({ actorUserId: "owner", orgId, jobId });
    expect(req.approvalId).toBeTruthy();
  });

  it("fails closed on bad intake, bad transitions, and missing crew/schedule", async () => {
    await expect(createJob({ actorUserId: "owner", orgId, customerName: "Bo", answers: { move_type: "local" } })).rejects.toMatchObject({ code: "VALIDATION" });

    const { jobId } = await makeJob();
    // Not estimate_ready yet.
    await expect(requestEstimateSend({ actorUserId: "owner", orgId, jobId })).rejects.toThrow();
    // Dispatch requires booked + crew + date.
    await expect(dispatchJob({ actorUserId: "owner", orgId, jobId })).rejects.toThrow();

    await prepareEstimate({ actorUserId: "owner", orgId, jobId });
    await unlockSending();
    await requestEstimateSend({ actorUserId: "owner", orgId, jobId });
    // Can't book while the approval is pending.
    await expect(recordJobOutcome({ actorUserId: "owner", orgId, jobId, outcome: "booked" })).rejects.toThrow();
    // Back to draft, then the send tool refuses a job no longer waiting on approval.
    await returnEstimateToDraft({ actorUserId: "owner", orgId, jobId });
    const tool = jobsTools()[0]!;
    await expect(tool.execute({ tenantId: orgId, taskId: "t", agentId: "a", idempotencyKey: "k" }, { jobId })).rejects.toThrow(/waiting on an estimate approval/);
  });

  it("rejects crew ids that are not members of this workspace", async () => {
    const { jobId } = await makeJob();
    await expect(assignCrew({ actorUserId: "owner", orgId, jobId, memberIds: ["outsider"] })).rejects.toMatchObject({ code: "VALIDATION" });
    const ok = await assignCrew({ actorUserId: "owner", orgId, jobId, memberIds: ["member"] });
    expect(ok.crew).toEqual(["member"]);
  });

  it("gates by role: outsiders get NOT_FOUND, members can't dispatch or cancel", async () => {
    const { jobId } = await makeJob();
    // Non-members don't learn the org exists.
    await expect(getJob({ actorUserId: "outsider", orgId, jobId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createJob({ actorUserId: "outsider", orgId, customerName: "X", answers: {} })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Members are staff but not managers.
    await expect(dispatchJob({ actorUserId: "member", orgId, jobId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(confirmJobsPricing({ actorUserId: "member", orgId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(cancelJob({ actorUserId: "member", orgId, jobId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps another org's jobs invisible (RLS + tenant-scoped store)", async () => {
    const { jobId } = await makeJob();
    const other = (await createOrg({ actorUserId: "owner", name: "Other Co" })).orgId;
    await withTenant(other, (tx) => writePackId(tx, other, "moving", "owner"));
    await expect(getJob({ actorUserId: "owner", orgId: other, jobId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const mine = await listJobs({ actorUserId: "owner", orgId });
    const theirs = await listJobs({ actorUserId: "owner", orgId: other });
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });

  it("refuses workspaces whose industry has no elite pack", async () => {
    const cafe = (await createOrg({ actorUserId: "owner", name: "Cafe Co" })).orgId;
    await withTenant(cafe, (tx) => writePackId(tx, cafe, "cafe", "owner"));
    await expect(createJob({ actorUserId: "owner", orgId: cafe, customerName: "X", answers: {} })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(jobFormConfig({ actorUserId: "owner", orgId: cafe })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("form config reports example pricing and missing business fields", async () => {
    const cfg = await jobFormConfig({ actorUserId: "owner", orgId });
    expect(cfg.packId).toBe("moving");
    expect(cfg.priceBasis).toBe("example");
    expect(cfg.requiredBusinessFields.some((f) => f.id === "business_address" && !f.filled)).toBe(true);
    expect(cfg.intake.length).toBeGreaterThan(5);

    await unlockSending();
    const after = await jobFormConfig({ actorUserId: "owner", orgId });
    expect(after.priceBasis).toBe("owner_configured");
    expect(after.requiredBusinessFields.find((f) => f.id === "business_address")?.filled).toBe(true);
  });

  it("rejects pricing overrides that name rules the pack does not have", async () => {
    await expect(confirmJobsPricing({ actorUserId: "owner", orgId, overrides: { nope: { cents: 1 } } })).rejects.toMatchObject({ code: "VALIDATION" });
    const ok = await confirmJobsPricing({ actorUserId: "owner", orgId, overrides: { stairs: { unitCents: 9999 } } });
    expect(ok.priceBasis).toBe("owner_configured");
  });
});
