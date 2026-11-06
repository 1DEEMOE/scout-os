import { and, asc, desc, eq, like, lt, type SQL } from "drizzle-orm";
import { auditEvents } from "@wos/db";
import { entryHashOf } from "../audit";
import { inOrg, MANAGERS, requireRole } from "../org/access";

export interface AuditFilter {
  actionPrefix?: string;
  actorType?: "user" | "agent" | "system";
  outcome?: "success" | "denied" | "error";
  /** Page backwards from this sequence number. */
  beforeSeq?: number;
  limit?: number;
}

/** Audit log, newest first. Owners and admins only: it shows everything that happened. */
export async function listAuditEvents(input: { actorUserId: string; orgId: string } & AuditFilter) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "audit.list");
    const where: SQL[] = [];
    if (input.actionPrefix) where.push(like(auditEvents.action, `${input.actionPrefix.replace(/[%_\\]/g, "\\$&")}%`));
    if (input.actorType) where.push(eq(auditEvents.actorType, input.actorType));
    if (input.outcome) where.push(eq(auditEvents.outcome, input.outcome));
    if (input.beforeSeq) where.push(lt(auditEvents.seq, input.beforeSeq));
    return tx
      .select()
      .from(auditEvents)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(auditEvents.seq))
      .limit(Math.min(Math.max(input.limit ?? 100, 1), 5000));
  });
}

const CSV_COLUMNS = ["seq", "at", "actor_type", "actor_id", "action", "target", "tier", "outcome", "approval_request_id", "metadata", "prev_hash", "entry_hash"] as const;

/** Quotes a CSV field and defuses spreadsheet formula injection (=, +, -, @). */
export function csvField(v: unknown): string {
  let s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export async function exportAuditCsv(input: { actorUserId: string; orgId: string } & AuditFilter): Promise<string> {
  const rows = await listAuditEvents({ ...input, limit: input.limit ?? 5000 });
  const lines = rows.map((r) =>
    [r.seq, r.at.toISOString(), r.actorType, r.actorId, r.action, r.target, r.tier, r.outcome, r.approvalRequestId, r.metadata, r.prevHash, r.entryHash].map(csvField).join(","),
  );
  return [CSV_COLUMNS.join(","), ...lines].join("\r\n") + "\r\n";
}

export interface ChainVerification {
  ok: boolean;
  /** Rows carrying a hash (checked). */
  checked: number;
  /** Rows written before the chain existed (skipped, reported). */
  legacy: number;
  brokenAtSeq?: number;
  reason?: string;
}

/**
 * Recomputes the audit hash chain (G4) for this org. Owners and admins only.
 * Fails on the first row whose stored hash doesn't match its content, whose
 * prevHash doesn't match the previous chained row, or that appears after the
 * chain started without carrying a hash.
 */
export async function verifyAuditChain(input: { actorUserId: string; orgId: string }): Promise<ChainVerification> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "audit.verify");
    const rows = await tx.select().from(auditEvents).orderBy(asc(auditEvents.seq));
    let legacy = 0;
    let checked = 0;
    let prevHash: string | null = null;
    let chainStarted = false;
    for (const r of rows) {
      if (!r.entryHash) {
        if (chainStarted) return { ok: false, checked, legacy, brokenAtSeq: r.seq, reason: "row without a hash after the chain started" };
        legacy++;
        continue;
      }
      if (!chainStarted && r.prevHash !== null) {
        return { ok: false, checked, legacy, brokenAtSeq: r.seq, reason: "first chained row points at a missing predecessor" };
      }
      if (chainStarted && r.prevHash !== prevHash) {
        return { ok: false, checked, legacy, brokenAtSeq: r.seq, reason: "broken link to the previous entry" };
      }
      const expected = entryHashOf(r.prevHash, {
        tenantId: r.tenantId,
        actorType: r.actorType,
        actorId: r.actorId,
        action: r.action,
        target: r.target,
        tier: r.tier,
        outcome: r.outcome,
        idempotencyKey: r.idempotencyKey,
        approvalRequestId: r.approvalRequestId,
        metadata: r.metadata,
        at: r.at,
      });
      if (expected !== r.entryHash) {
        return { ok: false, checked, legacy, brokenAtSeq: r.seq, reason: "stored hash does not match the row's content" };
      }
      chainStarted = true;
      prevHash = r.entryHash;
      checked++;
    }
    return { ok: true, checked, legacy };
  });
}
