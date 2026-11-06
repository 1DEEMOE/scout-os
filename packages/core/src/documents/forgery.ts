/**
 * Forged estimate / invoice detection.
 * Checks vendor bank details against on-file destinations (gaps-1),
 * duplicate numbers, amounts out of pattern, mismatched sender domains,
 * and altered PDF metadata. Raises Approvals; NEVER auto-pays.
 */
import { and, eq, ne } from "drizzle-orm";
import {
  agents,
  approvalRequests,
  incomingDocuments,
  invoices,
  paymentDestinations,
  tasks,
  type Tx,
} from "@wos/db";
import { recordAudit } from "../audit";
import { actionDigest } from "../engine/digest";
import { AppError } from "../errors";
import { ANY_ROLE, STAFF, inOrg, requireRole } from "../org/access";

export const FORGERY_REVIEW_TOOL = "finance.review_flagged_document";
export const FORGERY_MIN_TIER = 2 as const;

export type PdfMeta = {
  producer?: string;
  creator?: string;
  modDate?: string;
  createDate?: string;
  /** True when modDate is earlier than createDate or producer looks stripped. */
  suspicious?: boolean;
};

export type IncomingDocInput = {
  actorUserId: string;
  orgId: string;
  kind: "invoice" | "estimate";
  vendorName: string;
  vendorEmail?: string;
  documentNumber?: string;
  amountCents: number;
  currency?: string;
  senderDomain?: string;
  expectedDomain?: string;
  accountLast4?: string;
  destinationId?: string;
  pdfMetadata?: PdfMeta;
};

export type RiskFlag =
  | "bank_mismatch"
  | "unknown_bank"
  | "duplicate_number"
  | "amount_outlier"
  | "domain_mismatch"
  | "pdf_metadata_altered";

export const RISK_FLAG_LABELS: Record<RiskFlag, string> = {
  bank_mismatch: "bank details don't match what's on file",
  unknown_bank: "bank details aren't on file",
  duplicate_number: "duplicate document number",
  amount_outlier: "amount is far outside the usual pattern",
  domain_mismatch: "sender domain doesn't match",
  pdf_metadata_altered: "PDF metadata looks edited",
};

export function formatRiskFlag(flag: string): string {
  return RISK_FLAG_LABELS[flag as RiskFlag] ?? flag.replace(/_/g, " ");
}

export function formatRiskFlags(flags: readonly string[]): string {
  return flags.map(formatRiskFlag).join("; ");
}

function domainOf(emailOrDomain?: string | null): string | null {
  if (!emailOrDomain) return null;
  const s = emailOrDomain.trim().toLowerCase();
  if (s.includes("@")) return s.split("@").pop() ?? null;
  return s.replace(/^www\./, "") || null;
}

export function evaluatePdfMetadata(meta: PdfMeta | undefined): boolean {
  if (!meta) return false;
  if (meta.suspicious) return true;
  if (meta.modDate && meta.createDate && meta.modDate < meta.createDate) return true;
  if (meta.producer && /photoshop|gimp|edited|unknown/i.test(meta.producer) && meta.createDate && meta.modDate && meta.modDate !== meta.createDate) {
    return true;
  }
  return false;
}

export async function analyzeIncomingDocument(input: IncomingDocInput): Promise<{
  documentId: string;
  riskFlags: RiskFlag[];
  riskScore: number;
  approvalRequestId: string | null;
}> {
  if (input.amountCents < 0) throw new AppError("VALIDATION", "Amount cannot be negative");

  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "document.analyze");
    const flags: RiskFlag[] = [];

    // Bank details vs on-file (gaps-1 destinations).
    if (input.destinationId) {
      const [dest] = await tx.select().from(paymentDestinations).where(eq(paymentDestinations.id, input.destinationId));
      if (!dest || dest.status !== "active") {
        flags.push("unknown_bank");
      } else if (input.accountLast4 && dest.accountLast4 !== input.accountLast4) {
        flags.push("bank_mismatch");
      }
    } else if (input.accountLast4) {
      const matches = await tx
        .select()
        .from(paymentDestinations)
        .where(and(eq(paymentDestinations.accountLast4, input.accountLast4), eq(paymentDestinations.status, "active")));
      if (matches.length === 0) flags.push("unknown_bank");
    }

    if (input.documentNumber) {
      const [dup] = await tx
        .select({ id: incomingDocuments.id })
        .from(incomingDocuments)
        .where(and(eq(incomingDocuments.kind, input.kind), eq(incomingDocuments.documentNumber, input.documentNumber)))
        .limit(1);
      if (dup) flags.push("duplicate_number");
      // Also compare against synced customer invoices by number.
      const [invDup] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(eq(invoices.number, input.documentNumber))
        .limit(1);
      if (invDup) flags.push("duplicate_number");
    }

    // Amount outlier vs recent open invoices (simple median-ish check).
    const recent = await tx
      .select({ amount: invoices.amountDueCents })
      .from(invoices)
      .where(eq(invoices.status, "open"))
      .limit(20);
    if (recent.length >= 3) {
      const amounts = recent.map((r) => r.amount).sort((a, b) => a - b);
      const mid = amounts[Math.floor(amounts.length / 2)]!;
      if (mid > 0 && (input.amountCents > mid * 5 || input.amountCents < mid / 10)) {
        flags.push("amount_outlier");
      }
    }

    const sender = domainOf(input.senderDomain) ?? domainOf(input.vendorEmail);
    const expected = domainOf(input.expectedDomain);
    if (sender && expected && sender !== expected) flags.push("domain_mismatch");

    if (evaluatePdfMetadata(input.pdfMetadata)) flags.push("pdf_metadata_altered");

    const uniqueFlags = [...new Set(flags)];
    const riskScore = Math.min(100, uniqueFlags.length * 22 + (uniqueFlags.includes("bank_mismatch") ? 20 : 0));

    const docId = crypto.randomUUID();
    let approvalRequestId: string | null = null;
    let taskId: string | null = null;

    // Any risk → raise Approvals. Never auto-pay (we do not create a pay tool call).
    if (uniqueFlags.length > 0) {
      const [agent] = await tx.select().from(agents).where(eq(agents.kind, "finance"));
      const agentId =
        agent?.id ??
        (
          await tx
            .insert(agents)
            .values({ tenantId: input.orgId, kind: "finance", displayName: "Billing", status: "active" })
            .returning({ id: agents.id })
        )[0]!.id;

      const taskIdNew = crypto.randomUUID();
      const digest = actionDigest({
        tenantId: input.orgId,
        taskId: taskIdNew,
        agentId,
        step: 0,
        tool: FORGERY_REVIEW_TOOL,
        args: { documentId: docId },
      });
      const flagText = formatRiskFlags(uniqueFlags) || "needs review";
      await tx.insert(tasks).values({
          id: taskIdNew,
          tenantId: input.orgId,
          requestedBy: input.actorUserId,
          assignedAgentId: agentId,
          intent: `Review flagged ${input.kind} from ${input.vendorName.slice(0, 80)}`,
          title: `Flagged ${input.kind} · ${input.vendorName.slice(0, 60)}`,
          state: "WAITING_FOR_APPROVAL",
          input: { source: "forgery_check", documentId: docId },
          plan: {
            steps: [
              {
                index: 0,
                tool: FORGERY_REVIEW_TOOL,
                args: { documentId: docId },
                tier: FORGERY_MIN_TIER,
                decision: "needs_approval",
                summary: `Review flagged ${input.kind} (${flagText})`,
                digest,
              },
            ],
          },
        });
      taskId = taskIdNew;

      const [ap] = await tx
        .insert(approvalRequests)
        .values({
          tenantId: input.orgId,
          taskId: taskIdNew,
          agentId,
          toolName: FORGERY_REVIEW_TOOL,
          tier: Math.max(FORGERY_MIN_TIER, uniqueFlags.includes("bank_mismatch") ? 3 : 2) as 2 | 3,
          actionDigest: digest,
          payload: {
            tool: FORGERY_REVIEW_TOOL,
            args: { documentId: docId },
            step: 0,
            riskFlags: uniqueFlags,
            externalDataFields: ["vendorEmail", "documentNumber", "accountLast4"],
          },
          summary: `Flagged ${input.kind}: ${flagText}`,
          expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        })
        .returning({ id: approvalRequests.id });
      approvalRequestId = ap!.id;
      await tx
        .update(tasks)
        .set({
          plan: {
            steps: [
              {
                index: 0,
                tool: FORGERY_REVIEW_TOOL,
                args: { documentId: docId },
                tier: FORGERY_MIN_TIER,
                decision: "needs_approval",
                summary: `Review flagged ${input.kind} (${flagText})`,
                digest,
                approvalId: ap!.id,
              },
            ],
          },
        })
        .where(eq(tasks.id, taskIdNew));
    }

    await tx.insert(incomingDocuments).values({
      id: docId,
      tenantId: input.orgId,
      kind: input.kind,
      vendorName: input.vendorName.slice(0, 200),
      vendorEmail: input.vendorEmail?.slice(0, 200) ?? null,
      documentNumber: input.documentNumber?.slice(0, 80) ?? null,
      amountCents: input.amountCents,
      currency: (input.currency ?? "usd").slice(0, 8),
      senderDomain: sender,
      expectedDomain: expected,
      accountLast4: input.accountLast4 ?? null,
      destinationId: input.destinationId ?? null,
      pdfMetadata: input.pdfMetadata ?? {},
      riskFlags: uniqueFlags,
      riskScore,
      status: uniqueFlags.length ? "flagged" : "cleared",
      approvalRequestId,
      taskId,
      createdBy: input.actorUserId,
    });

    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "document.analyze",
      target: `incoming_document:${docId}`,
      approvalRequestId: approvalRequestId ?? undefined,
      tier: uniqueFlags.length ? FORGERY_MIN_TIER : 0,
      outcome: "success",
      metadata: {
        kind: input.kind,
        riskFlags: uniqueFlags,
        riskScore,
        // last4 only — never full account
        accountLast4: input.accountLast4 ?? null,
      },
    });

    return { documentId: docId, riskFlags: uniqueFlags, riskScore, approvalRequestId };
  });
}

export async function listFlaggedDocuments(input: { actorUserId: string; orgId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "document.list");
    return tx.select().from(incomingDocuments).where(eq(incomingDocuments.status, "flagged")).limit(50);
  });
}

/** Clear after human review — still never pays. */
export async function clearFlaggedDocument(tx: Tx, tenantId: string, documentId: string): Promise<void> {
  await tx
    .update(incomingDocuments)
    .set({ status: "cleared", resolvedAt: new Date() })
    .where(and(eq(incomingDocuments.id, documentId), ne(incomingDocuments.status, "paid_elsewhere")));
  await recordAudit(tx, {
    tenantId,
    actorType: "system",
    actorId: "forgery",
    action: "document.clear",
    target: `incoming_document:${documentId}`,
    tier: FORGERY_MIN_TIER,
    outcome: "success",
    metadata: { note: "cleared_after_review_no_autopay" },
  });
}
