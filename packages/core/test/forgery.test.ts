import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvalRequests, paymentDestinations, withTenant } from "@wos/db";
import {
  actionDigest,
  analyzeIncomingDocument,
  configureEngine,
  createOrg,
  evaluatePdfMetadata,
  formatRiskFlags,
  FakeInvoicingProvider,
  financeTools,
  MockModelProvider,
  ModelRouter,
  sealPaymentSecret,
  ToolRegistry,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

let orgId: string;
let destId: string;

beforeEach(async () => {
  await resetDb();
  await seedUser("owner", "owner@example.test");
  const billing = new FakeInvoicingProvider();
  configureEngine({
    router: new ModelRouter([new MockModelProvider(() => ({}))], "mock"),
    tools: new ToolRegistry().register(...financeTools(async () => billing)),
  });
  orgId = (await createOrg({ actorUserId: "owner", name: "Forge Co" })).orgId;
  destId = crypto.randomUUID();
  const sealed = sealPaymentSecret(
    { accountNumber: "123456789012", routingNumber: "021000021" },
    { tenantId: orgId, bindingId: destId },
  );
  await withTenant(orgId, (tx) =>
    tx.insert(paymentDestinations).values({
      id: destId,
      tenantId: orgId,
      kind: "vendor",
      label: "Acme Supply",
      accountLast4: sealed.accountLast4,
      routingLast4: sealed.routingLast4,
      ciphertext: sealed.ciphertext,
      createdBy: "owner",
    }),
  );
});

describe("forged estimate/invoice detection", () => {
  it("flags bank mismatch, domain mismatch, pdf metadata and raises approval without paying", async () => {
    expect(evaluatePdfMetadata({ createDate: "2026-01-02", modDate: "2026-01-01" })).toBe(true);

    const result = await analyzeIncomingDocument({
      actorUserId: "owner",
      orgId,
      kind: "invoice",
      vendorName: "Acme Supply",
      vendorEmail: "billing@evil.example",
      documentNumber: "INV-100",
      amountCents: 500_00,
      senderDomain: "evil.example",
      expectedDomain: "acme.example",
      accountLast4: "9999",
      destinationId: destId,
      pdfMetadata: { createDate: "2026-01-02", modDate: "2026-01-01", producer: "Edited" },
    });
    expect(result.riskFlags).toEqual(
      expect.arrayContaining(["bank_mismatch", "domain_mismatch", "pdf_metadata_altered"]),
    );
    expect(result.approvalRequestId).toBeTruthy();
    expect(result.riskScore).toBeGreaterThan(0);

    const [ap] = await withTenant(orgId, (tx) =>
      tx.select().from(approvalRequests).where(eq(approvalRequests.id, result.approvalRequestId!)),
    );
    expect(ap!.tier).toBeGreaterThanOrEqual(2);
    expect(ap!.toolName).toBe("finance.review_flagged_document");
  });

  it("clears with no flags when details match", async () => {
    const result = await analyzeIncomingDocument({
      actorUserId: "owner",
      orgId,
      kind: "estimate",
      vendorName: "Acme Supply",
      amountCents: 100_00,
      accountLast4: "9012",
      destinationId: destId,
      expectedDomain: "acme.example",
      senderDomain: "acme.example",
    });
    expect(result.riskFlags).toEqual([]);
    expect(result.approvalRequestId).toBeNull();
  });

  it("writes plain-language flag wording and the executor digest", async () => {
    expect(formatRiskFlags(["unknown_bank", "amount_outlier"])).toBe(
      "bank details aren't on file; amount is far outside the usual pattern",
    );
    expect(formatRiskFlags(["bank_mismatch"])).not.toContain("bank_mismatch");

    const result = await analyzeIncomingDocument({
      actorUserId: "owner",
      orgId,
      kind: "invoice",
      vendorName: "Acme Supply",
      vendorEmail: "billing@evil.example",
      documentNumber: "INV-200",
      amountCents: 500_00,
      senderDomain: "evil.example",
      expectedDomain: "acme.example",
      accountLast4: "9999",
      destinationId: destId,
      pdfMetadata: { createDate: "2026-01-02", modDate: "2026-01-01" },
    });
    const [ap] = await withTenant(orgId, (tx) =>
      tx.select().from(approvalRequests).where(eq(approvalRequests.id, result.approvalRequestId!)),
    );
    expect(ap!.summary).toContain("bank details don't match what's on file");
    expect(ap!.summary).toContain("sender domain doesn't match");
    expect(ap!.summary).not.toMatch(/unknown_bank|bank_mismatch|domain_mismatch|pdf_metadata_altered|amount_outlier/);
    expect(ap!.actionDigest).toBe(
      actionDigest({
        tenantId: orgId,
        taskId: ap!.taskId,
        agentId: ap!.agentId,
        step: 0,
        tool: "finance.review_flagged_document",
        args: { documentId: result.documentId },
      }),
    );
  });
});
