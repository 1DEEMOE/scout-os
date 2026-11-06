import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import { stopBoss } from "@wos/core";
import { appRouter, createCaller } from "../src/server/root";
import { makeContext } from "../src/server/trpc";
import { resetDb, seedUser } from "../../../packages/db/test/helpers";

// Discovers every API procedure and calls it as another org's owner and as a
// signed-out visitor. A procedure added later is covered automatically: it
// must either be listed as not org-scoped below, or refuse both callers.

// org.acceptInvitation exists for people who are NOT members yet (the whole point);
// the token + invited-email match is the gate, covered in org-membership tests.
const NOT_ORG_SCOPED = new Set(["org.create", "org.listMine", "org.acceptInvitation"]);
const NIL = "00000000-0000-4000-8000-000000000000";

let orgA: string;

/** One input that satisfies every procedure's schema (extra keys are stripped). */
const input = () => ({
  orgId: orgA,
  taskId: NIL,
  invitationId: NIL,
  connectionId: NIL,
  userId: "mallory",
  token: "probe-token-value",
  approvalId: NIL,
  conversationId: NIL,
  memoryId: NIL,
  threadId: NIL,
  title: "probe",
  identityId: NIL,
  decision: "approve",
  mode: "send_with_approval",
  intent: "probe",
  content: "probe",
  email: "victim@example.test",
  role: "owner",
  accessToken: "pat-probe-000000000",
  label: "probe",
  secretKey: "sk_test_probe1",
  budgetCents: 1,
  paused: true,
  spec: { kind: "sales", displayName: "x", instructions: "x", tools: [] },
  opportunityId: NIL,
  csv: "name\nprobe",
  reportDay: "2026-11-01",
  usageRights: "probe probe probe",
  attest: true,
  evidence: "probe evidence",
  reason: "opt_out",
  basis: "existing_customer",
  answers: {},
  profile: {},
  routineId: NIL,
  kind: "morning_briefing",
  name: "probe",
  hour: 7,
  minute: 0,
  daysOfWeek: [1],
  timezone: "America/New_York",
  clientRef: "probe-000000000",
  changeId: NIL,
  calledNumber: "5551234567",
  // onboarding wizard
  industry: "roofing",
  skipped: ["gmail"],
  mapping: { name: "fullName" },
  zip: "75201",
  county: "Dallas",
  state: "TX",
  // gaps-2
  displayName: "probe desk",
  channelId: NIL,
  slots: [{ startsAt: "2026-12-01T15:00:00.000Z", endsAt: "2026-12-01T16:00:00.000Z" }],
  jobId: NIL,
  filename: "probe.jpg",
  contentType: "image/jpeg",
  bytesBase64: "cHJvYmU=",
  captureAt: "2026-11-05T12:00:00.000Z",
  vendorName: "probe vendor",
  amountCents: 1,
  trade: "roofing",
  documentKind: "invoice",
});

beforeAll(async () => {
  await resetDb();
  await seedUser("alice", "alice@example.test");
  await seedUser("mallory", "mallory@example.test");
  orgA = (await createCaller(makeContext("alice")).org.create({ name: "Victim Co" })).orgId;
  await createCaller(makeContext("mallory")).org.create({ name: "Attacker Co" });
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

const procedures = Object.keys(appRouter._def.procedures).sort();

function call(userId: string | null, path: string) {
  const [ns, fn] = path.split(".") as [string, string];
  const caller = createCaller(makeContext(userId)) as unknown as Record<string, Record<string, (i: unknown) => Promise<unknown>>>;
  return caller[ns]![fn]!(input());
}

describe("every API procedure", () => {
  it("is discovered", () => {
    expect(procedures.length).toBeGreaterThan(30);
  });

  it.each(procedures.filter((p) => !NOT_ORG_SCOPED.has(p)))("%s refuses another org's owner", async (path) => {
    await expect(call("mallory", path)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each(procedures)("%s refuses a signed-out caller", async (path) => {
    await expect(call(null, path)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
