import { createHash, randomUUID } from "node:crypto";
import { desc, sql } from "drizzle-orm";
import { auditEvents, type Tx } from "@wos/db";
import { canonicalJson } from "./engine/digest";

export interface AuditInput {
  tenantId: string;
  actorType: "user" | "agent" | "system";
  actorId: string;
  action: string;
  target?: string;
  tier?: 0 | 1 | 2 | 3 | 4;
  outcome: "success" | "denied" | "error";
  idempotencyKey?: string;
  approvalRequestId?: string;
  metadata?: Record<string, unknown>;
}

/** The fields an entry hash commits to. seq and id order the chain but aren't hashed. */
export interface AuditEntryContent {
  tenantId: string;
  actorType: string;
  actorId: string;
  action: string;
  target: string | null;
  tier: number;
  outcome: string;
  idempotencyKey: string | null;
  approvalRequestId: string | null;
  metadata: Record<string, unknown>;
  at: Date;
}

/**
 * SHA-256 over the previous entry's hash and this entry's content (G4). Any
 * change to a chained row — or a deleted/reordered row — breaks the chain at a
 * computable point. Rows written before migration 0018 have NULL hashes and are
 * pre-chain history.
 */
export function entryHashOf(prevHash: string | null, e: AuditEntryContent): string {
  return createHash("sha256")
    .update(canonicalJson({ prevHash, entry: { ...e, at: e.at.toISOString() } }))
    .digest("hex");
}

/**
 * Appends an audit event inside the caller's tenant transaction. The per-tenant
 * advisory lock serializes writers so the hash chain is linear. app_user has no
 * UPDATE/DELETE on audit_events, so the chain can only grow.
 */
export async function recordAudit(tx: Tx, e: AuditInput): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${e.tenantId}))`);
  const [prev] = await tx.select({ entryHash: auditEvents.entryHash }).from(auditEvents).orderBy(desc(auditEvents.seq)).limit(1);
  const prevHash = prev?.entryHash ?? null;
  const content: AuditEntryContent = {
    tenantId: e.tenantId,
    actorType: e.actorType,
    actorId: e.actorId,
    action: e.action,
    target: e.target ?? null,
    tier: e.tier ?? 1,
    outcome: e.outcome,
    idempotencyKey: e.idempotencyKey ?? null,
    approvalRequestId: e.approvalRequestId ?? null,
    metadata: e.metadata ?? {},
    at: new Date(),
  };
  await tx.insert(auditEvents).values({
    id: randomUUID(),
    ...content,
    actorType: e.actorType,
    outcome: e.outcome,
    tier: e.tier ?? 1,
    // No rows yet, or the last row is pre-chain history: the chain starts here.
    prevHash,
    entryHash: entryHashOf(prevHash, content),
  });
}
