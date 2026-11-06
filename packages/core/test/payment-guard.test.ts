import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@wos/db";
import {
  AppError,
  configureEngine,
  createAgent,
  createOrg,
  createTask,
  decideApproval,
  enforcePaymentDetailTier,
  FakeInvoicingProvider,
  financeTools,
  inviteMember,
  listFlaggedPaymentChanges,
  MockModelProvider,
  ModelRouter,
  PAYMENT_DETAIL_MIN_TIER,
  recordPaymentCallback,
  runTask,
  stopBoss,
  ToolRegistry,
  type ModelResponse,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";
import { approvalsFor, auditActions } from "./engine-helpers";

let orgId: string;
let billing: FakeInvoicingProvider;
let plan: Partial<ModelResponse>;
let contactId: string;
const ON_FILE = "5551234567";
const ACCOUNT = "123456789012";
const ROUTING = "021000021";

async function expectCode(p: Promise<unknown>, code: AppError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
}

beforeEach(async () => {
  await resetDb();
  for (const u of ["owner", "admin", "member", "outsider"]) await seedUser(u, `${u}@example.test`);
  billing = new FakeInvoicingProvider();
  plan = { toolCalls: [] };
  configureEngine({
    router: new ModelRouter([new MockModelProvider((r) => (r.purpose === "classify" ? { text: "finance" } : plan))], "mock"),
    tools: new ToolRegistry().register(...financeTools(async () => billing)),
    invoicing: async () => billing,
  });
  orgId = (await createOrg({ actorUserId: "owner", name: "Pay Guard Co" })).orgId;
  await inviteMember({ actorUserId: "owner", orgId, email: "admin@example.test", role: "admin" });
  await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
  await createAgent({
    actorUserId: "owner",
    orgId,
    spec: {
      kind: "finance",
      displayName: "Finance",
      instructions: "Guard payment details.",
      tools: [
        { name: "finance.update_payment_destination", maxTier: 3 },
        { name: "finance.request_payment_with_new_destination", maxTier: 3 },
        { name: "finance.send_invoice_reminder", maxTier: 2 },
      ],
    },
  });
  contactId = await withTenant(orgId, async (tx) => {
    const r = await tx.execute(
      (await import("drizzle-orm")).sql`INSERT INTO contacts (tenant_id, name, email, phone) VALUES (${orgId}, 'Vendor Co', 'vendor@pay.test', ${ON_FILE}) RETURNING id`,
    );
    return (r.rows[0] as { id: string }).id;
  });
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("enforcePaymentDetailTier", () => {
  it("raises below-floor steps to 3 and never lowers a higher tier", () => {
    const out = enforcePaymentDetailTier([
      { tool: "finance.update_payment_destination", tier: 1 },
      { tool: "finance.request_payment_with_new_destination", tier: 4 },
      { tool: "finance.send_invoice_reminder", tier: 2 },
    ]);
    expect(out.map((s) => s.tier)).toEqual([PAYMENT_DETAIL_MIN_TIER, 4, 2]);
  });
});

describe("bank / payment-detail change guard", () => {
  it("creates a tier-3 approval + home flag; blocks approve until call-back on the on-file number", async () => {
    plan = {
      toolCalls: [
        {
          name: "finance.update_payment_destination",
          input: {
            kind: "vendor",
            label: "Vendor Co ACH",
            contactId,
            accountNumber: ACCOUNT,
            routingNumber: ROUTING,
            source: "email",
          },
        },
      ],
    };
    const { taskId } = await createTask({ actorUserId: "member", orgId, intent: "Update vendor bank details from email" });
    expect(await runTask(orgId, taskId)).toBe("WAITING_FOR_APPROVAL");

    const aps = await approvalsFor(orgId, taskId);
    expect(aps).toHaveLength(1);
    expect(aps[0]!.tier).toBe(3);
    expect(aps[0]!.toolName).toBe("finance.update_payment_destination");

    const flagged = await listFlaggedPaymentChanges({ actorUserId: "owner", orgId });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({
      accountLast4: "9012",
      source: "email",
      status: "awaiting_callback",
      onFilePhoneHint: "···4567",
    });
    // Never expose full account in the flag list
    expect(JSON.stringify(flagged)).not.toContain(ACCOUNT);

    // Approve without call-back is refused (wrong state → CONFLICT)
    await expectCode(
      decideApproval({ actorUserId: "admin", orgId, approvalId: aps[0]!.id, decision: "approve" }),
      "CONFLICT",
    );

    // Wrong number (e.g. from the request) refused + audited
    await expectCode(
      recordPaymentCallback({
        actorUserId: "admin",
        orgId,
        changeId: flagged[0]!.id,
        calledNumber: "9998887777",
      }),
      "FORBIDDEN",
    );
    const denied = (await auditActions(orgId)).filter((a) => a.action === "payment_detail.callback_denied");
    expect(denied).toHaveLength(1);
    expect(JSON.stringify(denied[0]!.metadata)).not.toMatch(/9998887777|123456789012/);

    // On-file number works
    await recordPaymentCallback({
      actorUserId: "admin",
      orgId,
      changeId: flagged[0]!.id,
      calledNumber: ON_FILE,
      notes: "Spoke with Pat",
    });

    await decideApproval({ actorUserId: "admin", orgId, approvalId: aps[0]!.id, decision: "approve" });
    expect(await runTask(orgId, taskId)).toBe("COMPLETED");

    const after = await listFlaggedPaymentChanges({ actorUserId: "owner", orgId });
    expect(after).toHaveLength(0);

    const audits = await auditActions(orgId);
    expect(audits.some((a) => a.action === "payment_detail.change_requested")).toBe(true);
    expect(audits.some((a) => a.action === "payment_detail.callback_verified")).toBe(true);
    expect(audits.some((a) => a.action === "payment_detail.applied")).toBe(true);
  });

  it("chat-sourced payment requests still always need approval; reject clears the home flag", async () => {
    plan = {
      toolCalls: [
        {
          name: "finance.request_payment_with_new_destination",
          input: {
            kind: "payee",
            label: "New payee",
            contactId,
            accountNumber: "9876543210",
            routingNumber: ROUTING,
            amountCents: 50000,
            source: "chat",
          },
        },
      ],
    };
    const { taskId } = await createTask({ actorUserId: "member", orgId, intent: "Pay from chat request" });
    expect(await runTask(orgId, taskId)).toBe("WAITING_FOR_APPROVAL");
    const [ap] = await approvalsFor(orgId, taskId);
    expect(ap!.tier).toBeGreaterThanOrEqual(3);
    const flagged = await listFlaggedPaymentChanges({ actorUserId: "owner", orgId });
    expect(flagged[0]!.source).toBe("chat");

    await decideApproval({ actorUserId: "admin", orgId, approvalId: ap!.id, decision: "reject" });
    expect(await listFlaggedPaymentChanges({ actorUserId: "owner", orgId })).toHaveLength(0);
  });
});
