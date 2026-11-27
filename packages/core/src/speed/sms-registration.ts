import { and, eq } from "drizzle-orm";
import { memoryRecords, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { MANAGERS, inOrg, requireRole } from "../org/access";
import { normalizePhone, smsPortForSend, twilioConfigFromEnv, type OutboundSms, type SmsSendResult } from "./sms";

/**
 * Carrier-registration enforcement for outbound SMS (A2P 10DLC / toll-free verification).
 *
 * FAIL CLOSED: a live text is sent only when the sending number has a recorded status of
 * "approved". Missing, pending, rejected, not-started, malformed or unreadable all block.
 * The labelled MOCK port is exempt because nothing leaves the building.
 *
 * Registration itself happens in Twilio/carrier processes. This code only refuses to send
 * until a human has recorded that it was approved. It cannot verify carrier state live.
 */

export type RegistrationStatus = "not_started" | "pending" | "approved" | "rejected";
export type RegistrationSource = "managed" | "owner_attested";

const MANAGED_SCOPE = "speed:managed-number";
const regScope = (phone: string) => `speed:smsreg:${phone}`;

export interface SendCheck { ok: boolean; reason?: string; source?: RegistrationSource }

const parse = (s: string): Record<string, unknown> | null => { try { const v = JSON.parse(s); return v && typeof v === "object" ? (v as Record<string, unknown>) : null; } catch { return null; } };
const STATUSES = new Set<string>(["not_started", "pending", "approved", "rejected"]);

/** Which number will a send use? The one the customer contacted, else the platform default. */
export function effectiveFromNumber(smsFrom?: string): string | null {
  const explicit = smsFrom ? normalizePhone(smsFrom) : null;
  if (explicit) return explicit;
  const dflt = twilioConfigFromEnv()?.fromNumber;
  return dflt ? normalizePhone(dflt) : null;
}

/**
 * May this tenant send a live SMS from `smsFrom` right now? Never throws: any failure to
 * decide is a block, with a reason an owner can act on.
 */
export async function smsRegistrationCheck(tx: Tx, tenantId: string, smsFrom?: string): Promise<SendCheck> {
  // The mock port sends nothing, so registration is irrelevant to it.
  if (smsPortForSend(smsFrom).mock) return { ok: true };
  try {
    const from = effectiveFromNumber(smsFrom);
    if (!from) return { ok: false, reason: "sms_registration_unverified" };
    const rows = await tx
      .select({ scopeRef: memoryRecords.scopeRef, content: memoryRecords.content })
      .from(memoryRecords)
      .where(and(eq(memoryRecords.tenantId, tenantId), eq(memoryRecords.layer, "org")));
    // A managed number's own record is authoritative for that number.
    const managed = rows.find((r) => r.scopeRef === MANAGED_SCOPE);
    const m = managed ? parse(managed.content) : null;
    if (m && m.phone === from && m.status === "active") {
      const a2p = String(m.a2p ?? "");
      return a2p === "approved" ? { ok: true, source: "managed" } : { ok: false, reason: `sms_registration_${STATUSES.has(a2p) ? a2p : "unverified"}`, source: "managed" };
    }
    const att = rows.find((r) => r.scopeRef === regScope(from));
    const a = att ? parse(att.content) : null;
    if (!a || a.phone !== from || !STATUSES.has(String(a.status))) return { ok: false, reason: "sms_registration_unverified" };
    return a.status === "approved" ? { ok: true, source: "owner_attested" } : { ok: false, reason: `sms_registration_${String(a.status)}`, source: "owner_attested" };
  } catch {
    return { ok: false, reason: "sms_registration_unverified" };
  }
}

export class SmsRegistrationBlocked extends Error {
  constructor(readonly reason: string) { super(`SMS not sent: ${reason}`); }
}

/**
 * The ONLY place that may call the SMS port. Re-checks registration immediately before the
 * send (so retries, approvals and scheduled sends cannot skip it) and throws if blocked.
 * A test fails if any other file calls smsPortForSend(...).send.
 */
export async function sendSmsGuarded(tx: Tx, tenantId: string, smsFrom: string | undefined, msg: Omit<OutboundSms, "tenantId">): Promise<SmsSendResult> {
  const check = await smsRegistrationCheck(tx, tenantId, smsFrom);
  if (!check.ok) throw new SmsRegistrationBlocked(check.reason ?? "sms_registration_unverified");
  return smsPortForSend(smsFrom).send({ ...msg, tenantId });
}

/**
 * Owner records that a number they brought themselves was registered or verified with the
 * carrier. An attestation is the owner's statement, not proof, and is audited as such.
 * Managed numbers are recorded through the managed-number flow instead.
 */
export async function attestSmsRegistration(input: { actorUserId: string; orgId: string; phone: string; status: RegistrationStatus }): Promise<{ phone: string; status: RegistrationStatus }> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new AppError("VALIDATION", "Enter the full phone number the texts are sent from.");
  if (!STATUSES.has(input.status)) throw new AppError("VALIDATION", "Unknown registration status.");
  await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "speed.sms_registration.attest");
    const content = JSON.stringify({ phone, status: input.status, source: "owner_attested", at: new Date().toISOString(), by: input.actorUserId });
    await tx.delete(memoryRecords).where(and(eq(memoryRecords.tenantId, input.orgId), eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, regScope(phone))));
    await tx.insert(memoryRecords).values({ tenantId: input.orgId, layer: "org", scopeRef: regScope(phone), content, trust: "user", createdByUser: input.actorUserId });
    await recordAudit(tx, {
      tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "speed.sms_registration.attest",
      target: `sms:${phone.slice(-4)}`, tier: 3, outcome: "success", metadata: { status: input.status, source: "owner_attested" },
    });
  });
  return { phone, status: input.status };
}
