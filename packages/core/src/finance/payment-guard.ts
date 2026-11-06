/**
 * Bank / remittance detail change guard (gaps-1).
 *
 * Any change to a customer's, vendor's or payee's bank or remittance details —
 * or a payment request that carries new account info — creates a tier-3+
 * approval and requires a recorded call-back on a phone number already on
 * file for that contact. The number from the change request is never trusted.
 *
 * Never loosens existing approval tiers. Requests that arrive via email or
 * chat still always need approval (source is recorded; taintedArgs already
 * forces ≥ tier 2, and these tools are tier 3).
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  contacts,
  paymentDetailChanges,
  paymentDestinations,
  type Tx,
} from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { ANY_ROLE, MANAGERS, auditDenied, inOrg, requireRole } from "../org/access";
import { decryptSecret, encryptSecret } from "../secrets";

export const PAYMENT_DETAIL_TOOLS = new Set([
  "finance.update_payment_destination",
  "finance.request_payment_with_new_destination",
]);

/** Floor for payment-detail tools. Policy must never evaluate them below this. */
export const PAYMENT_DETAIL_MIN_TIER = 3 as const;

export type PaymentDestinationKind = "customer" | "vendor" | "payee";
export type PaymentChangeSource = "agent" | "email" | "chat" | "user";

export interface PaymentSecret {
  accountNumber: string;
  routingNumber?: string;
}

function last4(n: string): string {
  const digits = n.replace(/\D/g, "");
  if (digits.length < 4) throw new AppError("VALIDATION", "Account number must have at least 4 digits");
  return digits.slice(-4);
}

function normalizePhone(p: string): string {
  return p.replace(/\D/g, "");
}

/** Encrypt payment secret bound to tenant + a stable id (destination or change). */
export function sealPaymentSecret(
  secret: PaymentSecret,
  binding: { tenantId: string; bindingId: string },
): { ciphertext: string; accountLast4: string; routingLast4: string | null } {
  const accountNumber = secret.accountNumber.replace(/\s+/g, "");
  const routingNumber = secret.routingNumber?.replace(/\s+/g, "") || undefined;
  if (!/^\d{4,17}$/.test(accountNumber)) throw new AppError("VALIDATION", "Account number looks invalid");
  if (routingNumber && !/^\d{9}$/.test(routingNumber)) throw new AppError("VALIDATION", "Routing number must be 9 digits");
  const ciphertext = encryptSecret(
    { accountNumber, ...(routingNumber ? { routingNumber } : {}) },
    { tenantId: binding.tenantId, connectionId: binding.bindingId },
  );
  return {
    ciphertext,
    accountLast4: last4(accountNumber),
    routingLast4: routingNumber ? last4(routingNumber) : null,
  };
}

export function openPaymentSecret(
  ciphertext: string,
  binding: { tenantId: string; bindingId: string },
): PaymentSecret {
  return decryptSecret<PaymentSecret>(ciphertext, { tenantId: binding.tenantId, connectionId: binding.bindingId });
}

/**
 * Called when an approval request is created for a payment-detail tool.
 * Creates (or links) a payment_detail_changes row awaiting call-back.
 * Full account numbers never land in audit metadata — last4 only.
 */
export async function linkPaymentChangeToApproval(
  tx: Tx,
  input: {
    tenantId: string;
    approvalRequestId: string;
    taskId: string;
    toolName: string;
    args: Record<string, unknown>;
    createdBy: string;
    source?: PaymentChangeSource;
  },
): Promise<{ changeId: string } | null> {
  if (!PAYMENT_DETAIL_TOOLS.has(input.toolName)) return null;

  const kind = (input.args.kind as PaymentDestinationKind) ?? "payee";
  const label = String(input.args.label ?? "Payment destination").slice(0, 200);
  const contactId = typeof input.args.contactId === "string" ? input.args.contactId : null;
  const destinationId = typeof input.args.destinationId === "string" ? input.args.destinationId : null;
  const accountNumber = String(input.args.accountNumber ?? "");
  const routingNumber = input.args.routingNumber != null ? String(input.args.routingNumber) : undefined;
  // Provisional binding id = approval id until destination exists.
  const changeId = crypto.randomUUID();
  const sealed = sealPaymentSecret(
    { accountNumber, routingNumber },
    { tenantId: input.tenantId, bindingId: changeId },
  );
  const source: PaymentChangeSource =
    input.source ??
    (input.args.source === "email" || input.args.source === "chat" || input.args.source === "user"
      ? (input.args.source as PaymentChangeSource)
      : "agent");

  const [row] = await tx
    .insert(paymentDetailChanges)
    .values({
      id: changeId,
      tenantId: input.tenantId,
      kind,
      contactId,
      destinationId,
      label,
      proposedAccountLast4: sealed.accountLast4,
      proposedRoutingLast4: sealed.routingLast4,
      proposedCiphertext: sealed.ciphertext,
      source,
      approvalRequestId: input.approvalRequestId,
      taskId: input.taskId,
      status: "awaiting_callback",
      flaggedOnHome: true,
      createdBy: input.createdBy,
    })
    .returning({ id: paymentDetailChanges.id });

  await recordAudit(tx, {
    tenantId: input.tenantId,
    actorType: "system",
    actorId: "payment.guard",
    action: "payment_detail.change_requested",
    target: `payment_detail_change:${row!.id}`,
    approvalRequestId: input.approvalRequestId,
    tier: PAYMENT_DETAIL_MIN_TIER,
    outcome: "success",
    metadata: {
      kind,
      accountLast4: sealed.accountLast4,
      routingLast4: sealed.routingLast4,
      source,
      tool: input.toolName,
      // Never log account numbers or phones from the request.
    },
  });
  return { changeId: row!.id };
}

/** Gate used by decideApproval: payment-detail tools need a verified call-back first. */
export async function assertPaymentCallbackVerified(tx: Tx, approvalRequestId: string, toolName: string): Promise<void> {
  if (!PAYMENT_DETAIL_TOOLS.has(toolName)) return;
  const [change] = await tx
    .select()
    .from(paymentDetailChanges)
    .where(eq(paymentDetailChanges.approvalRequestId, approvalRequestId))
    .limit(1);
  if (!change) {
    throw new AppError(
      "CONFLICT",
      "This payment-detail change is missing its guard record. Decline it and ask the agent to propose it again.",
    );
  }
  if (!change.callbackVerifiedAt) {
    throw new AppError(
      "CONFLICT",
      "Record a call-back on the phone number already on file before approving this bank-detail change.",
      { changeId: change.id, status: change.status },
    );
  }
}

/**
 * Record a call-back verification. The number dialed must match the contact's
 * phone already on file — never a number supplied in the change request.
 */
export async function recordPaymentCallback(input: {
  actorUserId: string;
  orgId: string;
  changeId: string;
  /** Number the reviewer actually dialed. */
  calledNumber: string;
  notes?: string;
}): Promise<{ status: "awaiting_approval" }> {
  const dialed = normalizePhone(input.calledNumber);
  if (dialed.length < 10) throw new AppError("VALIDATION", "Enter the full phone number you called");

  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "payment_detail.callback");
    const [change] = await tx
      .select()
      .from(paymentDetailChanges)
      .where(eq(paymentDetailChanges.id, input.changeId))
      .for("update");
    if (!change) throw new AppError("NOT_FOUND", "Payment detail change not found");
    if (change.status !== "awaiting_callback" && change.status !== "awaiting_approval") {
      throw new AppError("CONFLICT", `This change is already ${change.status.replace("_", " ")}`);
    }
    if (!change.contactId) {
      throw new AppError(
        "CONFLICT",
        "This payee has no linked contact with a phone on file. Add a phone on the contact first, then call back.",
      );
    }
    const [contact] = await tx.select().from(contacts).where(eq(contacts.id, change.contactId));
    if (!contact?.phone) {
      throw new AppError(
        "CONFLICT",
        "No phone number is on file for this contact. Save a verified phone on the contact, then call that number back.",
      );
    }
    const onFile = normalizePhone(contact.phone);
    if (!onFile || onFile !== dialed) {
      // Out-of-band: the throw below rolls back this tx.
      await auditDenied(input.orgId, input.actorUserId, "payment_detail.callback_denied", {
        changeId: change.id,
        reason: "phone_mismatch_or_not_on_file",
        // Never log the dialed number or any request phone.
      });
      throw new AppError(
        "FORBIDDEN",
        "Call-back must use the phone number already on file for this contact — not a number from the change request.",
      );
    }

    await tx
      .update(paymentDetailChanges)
      .set({
        status: "awaiting_approval",
        callbackPhoneUsed: contact.phone, // store the on-file value, not the request
        callbackVerifiedAt: new Date(),
        callbackVerifiedBy: input.actorUserId,
        callbackNotes: input.notes?.trim().slice(0, 1000) || null,
      })
      .where(eq(paymentDetailChanges.id, change.id));

    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "payment_detail.callback_verified",
      target: `payment_detail_change:${change.id}`,
      approvalRequestId: change.approvalRequestId ?? undefined,
      tier: PAYMENT_DETAIL_MIN_TIER,
      outcome: "success",
      metadata: { changeId: change.id, accountLast4: change.proposedAccountLast4 },
    });
    return { status: "awaiting_approval" };
  });
}

/** Apply an approved change: write/replace the destination. Called from tool execute. */
export async function applyPaymentDestinationChange(
  tx: Tx,
  input: {
    tenantId: string;
    actorId: string;
    kind: PaymentDestinationKind;
    contactId: string | null;
    label: string;
    accountNumber: string;
    routingNumber?: string;
    destinationId?: string | null;
    taskId?: string | null;
    approvalRequestId?: string | null;
  },
): Promise<{ destinationId: string; accountLast4: string }> {
  // Prefer ciphertext already sealed on the change row (bound to change id).
  let ciphertext: string | undefined;
  let accountLast4: string | undefined;
  let routingLast4: string | null | undefined;
  let changeId: string | null = null;
  let approvalRequestId = input.approvalRequestId ?? null;

  const loadChange = async () => {
    if (input.taskId) {
      const rows = await tx
        .select()
        .from(paymentDetailChanges)
        .where(eq(paymentDetailChanges.taskId, input.taskId))
        .orderBy(desc(paymentDetailChanges.createdAt))
        .limit(1);
      if (!rows[0]) return undefined;
      const [c] = await tx
        .select()
        .from(paymentDetailChanges)
        .where(eq(paymentDetailChanges.id, rows[0].id))
        .for("update");
      return c;
    }
    if (input.approvalRequestId) {
      const [c] = await tx
        .select()
        .from(paymentDetailChanges)
        .where(eq(paymentDetailChanges.approvalRequestId, input.approvalRequestId))
        .for("update");
      return c;
    }
    return undefined;
  };

  const change = await loadChange();
  if (change) {
    if (!change.callbackVerifiedAt) {
      throw new AppError("FORBIDDEN", "Call-back verification is required before applying payment details");
    }
    ciphertext = change.proposedCiphertext;
    accountLast4 = change.proposedAccountLast4;
    routingLast4 = change.proposedRoutingLast4;
    changeId = change.id;
    approvalRequestId = change.approvalRequestId;
  }

  if (!changeId) {
    // Direct apply path (should be rare; still requires prior approval via tool tier).
    const provisionalId = input.destinationId ?? crypto.randomUUID();
    const sealed = sealPaymentSecret(
      { accountNumber: input.accountNumber, routingNumber: input.routingNumber },
      { tenantId: input.tenantId, bindingId: provisionalId },
    );
    ciphertext = sealed.ciphertext;
    accountLast4 = sealed.accountLast4;
    routingLast4 = sealed.routingLast4;
  }

  if (input.destinationId) {
    await tx
      .update(paymentDestinations)
      .set({ status: "replaced", updatedAt: new Date() })
      .where(and(eq(paymentDestinations.id, input.destinationId), eq(paymentDestinations.status, "active")));
  }

  const destId = crypto.randomUUID();
  // Re-bind ciphertext to the destination id so decrypt stays possible without the approval id.
  if (changeId && ciphertext) {
    const opened = openPaymentSecret(ciphertext, { tenantId: input.tenantId, bindingId: changeId });
    const resealed = sealPaymentSecret(opened, { tenantId: input.tenantId, bindingId: destId });
    ciphertext = resealed.ciphertext;
    accountLast4 = resealed.accountLast4;
    routingLast4 = resealed.routingLast4;
  }

  const [dest] = await tx
    .insert(paymentDestinations)
    .values({
      id: destId,
      tenantId: input.tenantId,
      kind: input.kind,
      contactId: input.contactId,
      label: input.label.slice(0, 200),
      accountLast4: accountLast4!,
      routingLast4: routingLast4 ?? null,
      ciphertext: ciphertext!,
      status: "active",
      createdBy: input.actorId,
    })
    .returning({ id: paymentDestinations.id });

  if (changeId) {
    await tx
      .update(paymentDetailChanges)
      .set({
        status: "approved",
        destinationId: dest!.id,
        flaggedOnHome: false,
        resolvedAt: new Date(),
      })
      .where(eq(paymentDetailChanges.id, changeId));
  }

  await recordAudit(tx, {
    tenantId: input.tenantId,
    actorType: "agent",
    actorId: input.actorId,
    action: "payment_detail.applied",
    target: `payment_destination:${dest!.id}`,
    approvalRequestId: approvalRequestId ?? undefined,
    tier: PAYMENT_DETAIL_MIN_TIER,
    outcome: "success",
    metadata: { kind: input.kind, accountLast4: accountLast4!, changeId },
  });

  return { destinationId: dest!.id, accountLast4: accountLast4! };
}

/** Open payment-detail changes for the Today home flag. */
export async function listFlaggedPaymentChanges(input: {
  actorUserId: string;
  orgId: string;
}): Promise<
  Array<{
    id: string;
    kind: string;
    label: string;
    accountLast4: string;
    status: string;
    source: string;
    createdAt: Date;
    callbackVerifiedAt: Date | null;
    approvalRequestId: string | null;
    /** Masked on-file contact phone (never from the change request). */
    onFilePhoneHint: string | null;
  }>
> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "payment_detail.list");
    const rows = await tx
      .select({
        id: paymentDetailChanges.id,
        kind: paymentDetailChanges.kind,
        label: paymentDetailChanges.label,
        accountLast4: paymentDetailChanges.proposedAccountLast4,
        status: paymentDetailChanges.status,
        source: paymentDetailChanges.source,
        createdAt: paymentDetailChanges.createdAt,
        callbackVerifiedAt: paymentDetailChanges.callbackVerifiedAt,
        approvalRequestId: paymentDetailChanges.approvalRequestId,
        contactId: paymentDetailChanges.contactId,
      })
      .from(paymentDetailChanges)
      .where(
        and(
          eq(paymentDetailChanges.flaggedOnHome, true),
          inArray(paymentDetailChanges.status, ["awaiting_callback", "awaiting_approval"]),
        ),
      )
      .orderBy(desc(paymentDetailChanges.createdAt))
      .limit(20);

    const out = [];
    for (const r of rows) {
      let onFilePhoneHint: string | null = null;
      if (r.contactId) {
        const phone = await contactPhoneOnFile(tx, r.contactId);
        if (phone) {
          const digits = phone.replace(/\D/g, "");
          onFilePhoneHint = digits.length >= 4 ? `···${digits.slice(-4)}` : "on file";
        }
      }
      const { contactId: _c, ...rest } = r;
      out.push({ ...rest, onFilePhoneHint });
    }
    return out;
  });
}

/** Mark rejected when the linked approval is rejected. */
export async function markPaymentChangeRejected(tx: Tx, approvalRequestId: string): Promise<void> {
  await tx
    .update(paymentDetailChanges)
    .set({ status: "rejected", flaggedOnHome: false, resolvedAt: new Date() })
    .where(
      and(
        eq(paymentDetailChanges.approvalRequestId, approvalRequestId),
        inArray(paymentDetailChanges.status, ["awaiting_callback", "awaiting_approval"]),
      ),
    );
}

/** Raise a plan step's tier to the payment-detail floor without ever lowering it. */
export function enforcePaymentDetailTier<T extends { tool: string; tier: number }>(steps: T[]): T[] {
  return steps.map((s) => {
    if (!PAYMENT_DETAIL_TOOLS.has(s.tool)) return s;
    if (s.tier >= PAYMENT_DETAIL_MIN_TIER) return s;
    return { ...s, tier: PAYMENT_DETAIL_MIN_TIER };
  });
}

/** Phone digits currently on file for a contact (for UI hint; never from the request). */
export async function contactPhoneOnFile(
  tx: Tx,
  contactId: string,
): Promise<string | null> {
  const [c] = await tx.select({ phone: contacts.phone }).from(contacts).where(eq(contacts.id, contactId));
  return c?.phone ?? null;
}
