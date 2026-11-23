import { and, desc, eq, isNull } from "drizzle-orm";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { inOrg, MANAGERS, requireRole } from "../org/access";
import { auditEvents, proposedSchema } from "@wos/db";

// Pending proposed 0022 table (see packages/db/src/schema-proposed.ts); used only when WOS_DURABLE_EVENTS=1.
const { deadLetters } = proposedSchema;
import { listAuditEvents } from "../audit-log/service";
import { activeJournal, durableEventsEnabled } from "./journal";
import { runEvent, type BusEvent, type BusHandler } from "./bus";

const handlers = new Map<string, BusHandler>();

export function registerBusHandler(handler: BusHandler): void {
  if (handler.maxTier !== 0 && handler.maxTier !== 1) throw new Error(`bus handler ${handler.type} is above tier 1`);
  handlers.set(handler.type, handler);
}

export function busHandler(type: string): BusHandler | undefined {
  return handlers.get(type);
}

/** Legacy path (default): dead letters are `ops.dead_letter` rows on audit_events. */
async function listDeadLettersFromAudit(input: { actorUserId: string; orgId: string }) {
  const rows = await listAuditEvents({ actorUserId: input.actorUserId, orgId: input.orgId, actionPrefix: "ops.dead_letter", limit: 500 });
  const resolved = new Set(rows.filter((r) => r.action === "ops.dead_letter.resolved").map((r) => String(r.metadata.deadLetterId ?? "")));
  return rows
    .filter((r) => r.action === "ops.dead_letter" && !resolved.has(r.id))
    .map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      type: String(r.metadata.type ?? ""),
      source: String(r.metadata.source ?? ""),
      integration: String(r.metadata.integration ?? ""),
      error: String(r.metadata.error ?? ""),
      attempts: Number(r.metadata.attempts ?? 0),
    }));
}

/**
 * Open dead letters. Reads the durable 0022 table only when WOS_DURABLE_EVENTS=1
 * (the owner has adopted 0022); otherwise reads the audit trail, which needs no
 * proposed SQL.
 */
export async function listDeadLetters(input: { actorUserId: string; orgId: string }) {
  if (!durableEventsEnabled()) return listDeadLettersFromAudit(input);
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "ops.replay");
    const rows = await tx
      .select()
      .from(deadLetters)
      .where(isNull(deadLetters.replayedAt))
      .orderBy(desc(deadLetters.createdAt))
      .limit(500);
    return rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      type: r.type,
      source: r.source,
      integration: r.integration,
      error: r.error,
      attempts: r.attempts,
    }));
  });
}

/**
 * A manager asks the bus to try a dead-lettered tier 0–1 handler again.
 * The original idempotency key is reused, so a success still happens once.
 * Payload is not stored (it may have held customer text) — the handler refetches.
 */
export async function replayDeadLetter(input: { actorUserId: string; orgId: string; deadLetterId: string }) {
  const durable = durableEventsEnabled();
  const targetPrefix = durable ? "dead-letter" : "audit";
  const event = await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "ops.replay");
    let found: { id: string; type: string; eventKey: string; integration: string };
    if (durable) {
      const [row] = await tx.select().from(deadLetters).where(eq(deadLetters.id, input.deadLetterId));
      if (!row) throw new AppError("NOT_FOUND", "That dead letter is not in this workspace");
      found = { id: row.id, type: row.type, eventKey: row.eventKey, integration: row.integration };
    } else {
      const [row] = await tx.select().from(auditEvents).where(eq(auditEvents.id, input.deadLetterId));
      if (!row || row.action !== "ops.dead_letter" || !row.idempotencyKey?.startsWith("dlq:")) {
        throw new AppError("NOT_FOUND", "That dead letter is not in this workspace");
      }
      const eventKey = String(row.metadata.eventKey ?? "");
      if (!eventKey) throw new AppError("CONFLICT", "This dead letter has no event key");
      found = { id: row.id, type: String(row.metadata.type ?? ""), eventKey, integration: String(row.metadata.integration ?? "") };
    }
    const handler = handlers.get(found.type);
    if (!handler) throw new AppError("CONFLICT", "Nothing in this process can replay that event");
    const busEvent: BusEvent = {
      tenantId: input.orgId,
      idempotencyKey: found.eventKey,
      type: found.type,
      source: "replay",
      integration: found.integration || undefined,
      payload: {},
    };
    return { busEvent, handler, deadLetterId: found.id };
  });
  const result = await runEvent(event.busEvent, event.handler, { journal: activeJournal() });
  const ok = result.status === "done" || result.status === "duplicate";
  await inOrg(input.orgId, async (tx) => {
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "ops.dead_letter.replay",
      target: `${targetPrefix}:${event.deadLetterId}`,
      tier: 1,
      outcome: ok ? "success" : "error",
      metadata: { type: event.busEvent.type, status: result.status },
    });
    if (ok) {
      if (durable) await tx
        .update(deadLetters)
        .set({ replayedAt: new Date() })
        .where(and(eq(deadLetters.id, event.deadLetterId), isNull(deadLetters.replayedAt)));
      await recordAudit(tx, {
        tenantId: input.orgId,
        actorType: "user",
        actorId: input.actorUserId,
        action: "ops.dead_letter.resolved",
        target: `${targetPrefix}:${event.deadLetterId}`,
        tier: 1,
        outcome: "success",
        metadata: { deadLetterId: event.deadLetterId, eventKey: event.busEvent.idempotencyKey },
      });
    }
  });
  return result;
}
