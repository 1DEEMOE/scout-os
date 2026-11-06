import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvalRequests, incomingDocuments, paymentDestinations, withTenant } from "@wos/db";
import {
  analyzeIncomingDocument,
  approvalsForReview,
  configureEngine,
  createOrg,
  decideApproval,
  FakeInvoicingProvider,
  financeTools,
  inviteMember,
  isOwnerOnly,
  MockModelProvider,
  ModelRouter,
  OWNER_ONLY_TOOLS,
  PAYMENT_DETAIL_TOOLS,
  sealPaymentSecret,
  ToolRegistry,
} from "../src/index";
import { adminQuery, resetDb, seedUser } from "../../db/test/helpers";

let orgId: string;
let destId: string;

beforeEach(async () => {
  await resetDb();
  await seedUser("owner", "owner@example.test");
  await seedUser("admin", "admin@example.test");
  await seedUser("owner2", "owner2@example.test");
  const billing = new FakeInvoicingProvider();
  configureEngine({ router: new ModelRouter([new MockModelProvider(() => ({}))], "mock"), tools: new ToolRegistry().register(...financeTools(async () => billing)) });
  orgId = (await createOrg({ actorUserId: "owner", name: "Hold Co" })).orgId;
  await inviteMember({ actorUserId: "owner", orgId, email: "admin@example.test", role: "admin" });
  destId = crypto.randomUUID();
  const sealed = sealPaymentSecret({ accountNumber: "123456789012", routingNumber: "021000021" }, { tenantId: orgId, bindingId: destId });
  await withTenant(orgId, (tx) =>
    tx.insert(paymentDestinations).values({ id: destId, tenantId: orgId, kind: "vendor", label: "Acme Supply", accountLast4: sealed.accountLast4, routingLast4: sealed.routingLast4, ciphertext: sealed.ciphertext, createdBy: "owner" }),
  );
});

const forged = (actorUserId = "admin") =>
  analyzeIncomingDocument({
    actorUserId,
    orgId,
    kind: "invoice",
    vendorName: "Acme Supply",
    vendorEmail: "billing@evil.example",
    documentNumber: `INV-${Math.floor(Math.random() * 1e6)}`,
    amountCents: 4_200_00,
    senderDomain: "evil.example",
    expectedDomain: "acme.example",
    accountLast4: "9999",
    destinationId: destId,
  });

describe("owner-only holds", () => {
  it("covers every bank-detail change tool, forged-invoice review and first outreach", () => {
    for (const t of PAYMENT_DETAIL_TOOLS) expect(isOwnerOnly(t)).toBe(true);
    expect(isOwnerOnly("finance.review_flagged_document")).toBe(true);
    expect(isOwnerOnly("scout.send_outreach")).toBe(true);
    expect(isOwnerOnly("inbox.send_draft")).toBe(false); // ordinary tier-2 approvals are unchanged
    expect(OWNER_ONLY_TOOLS.size).toBe(PAYMENT_DETAIL_TOOLS.size + 2);
  });

  it("an admin can't approve or reject a possibly forged invoice; an owner can; nothing is ever paid", async () => {
    const r = await forged();
    expect(r.approvalRequestId).toBeTruthy();
    const id = r.approvalRequestId!;
    for (const decision of ["approve", "reject"] as const) {
      await expect(decideApproval({ actorUserId: "admin", orgId, approvalId: id, decision })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/Only an owner/) });
    }
    const denied = await adminQuery<{ outcome: string }>("SELECT outcome FROM audit_events WHERE tenant_id = $1 AND metadata->>'reason' = 'owner_only'", [orgId]);
    expect(denied.length).toBe(2);
    // The reviewer view tells the admin why, instead of showing a button that fails.
    const asAdmin = await approvalsForReview({ actorUserId: "admin", orgId });
    const item = asAdmin.open.find((o) => o.approval.id === id)!;
    expect(item.ownerOnly).toBe(true);
    expect(item.reviewer).toMatchObject({ kind: "read_only", reason: expect.stringMatching(/Only an owner can release an invoice/) });
    const asOwner = await approvalsForReview({ actorUserId: "owner", orgId });
    expect(asOwner.open.find((o) => o.approval.id === id)!.reviewer.kind).toBe("can_approve");
    await decideApproval({ actorUserId: "owner", orgId, approvalId: id, decision: "reject" });
    const [ap] = await withTenant(orgId, (tx) => tx.select().from(approvalRequests).where(eq(approvalRequests.id, id)));
    expect(ap!.status).toBe("rejected");
    // Never auto-paid: the document never reaches a paid state on its own.
    const docs = await withTenant(orgId, (tx) => tx.select({ status: incomingDocuments.status }).from(incomingDocuments));
    expect(docs.every((d) => d.status !== "paid_elsewhere")).toBe(true);
  });

  it("an owner who asked for the work needs a different owner, unless they're the only owner", async () => {
    const r = await forged("owner");
    const id = r.approvalRequestId!;
    // Only one owner (plus an admin): sole-owner exception, audited, and the admin still can't decide.
    const view = await approvalsForReview({ actorUserId: "owner", orgId });
    expect(view.open.find((o) => o.approval.id === id)!.reviewer).toMatchObject({ kind: "can_approve", note: expect.stringMatching(/only owner/) });
    await inviteMember({ actorUserId: "owner", orgId, email: "owner2@example.test", role: "owner" });
    await expect(decideApproval({ actorUserId: "owner", orgId, approvalId: id, decision: "approve" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/another owner/) });
    await expect(decideApproval({ actorUserId: "admin", orgId, approvalId: id, decision: "approve" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await decideApproval({ actorUserId: "owner2", orgId, approvalId: id, decision: "reject" });
  });
});
