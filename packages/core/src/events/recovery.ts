import { eq } from "drizzle-orm";
import { auditEvents } from "@wos/db";
import { recordAudit } from "../audit";
import { listAuditEvents } from "../audit-log/service";
import { AppError } from "../errors";
import { inOrg, MANAGERS, requireRole } from "../org/access";
import { auditJournal } from "./journal";
import { runEvent, type BusEvent, type BusHandler } from "./bus";

const handlers = new Map<string, BusHandler>();

export function registerBusHandler(handler: BusHandler): void {
  if (handler.maxTier !== 0 && handler.maxTier !== 1) throw new Error(`bus handler ${handler.type} is above tier 1`);
  handlers.set(handler.type, handler);
}

export function busHandler(type: string): BusHandler | undefined {
  return handlers.get(type);
}

export async function listDeadLetters(input: { actorUserId: string; orgId: string }) {
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
 * A manager asks the bus to try a dead-lettered tier 0–1 handler again.
 * The original idempotency key is reused, so a success still happens once.
 * Payload is not stored (it may have held customer text) — the handler refetches.
 */
export async function replayDeadLetter(input: { actorUserId: string; orgId: string; auditId: string }) {
  const event = await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "ops.replay");
    const [row] = await tx.select().from(auditEvents).where(eq(auditEvents.id, input.auditId));
    if (!row || row.action !== "ops.dead_letter" || !row.idempotencyKey?.startsWith("dlq:")) {
      throw new AppError("NOT_FOUND", "That dead letter is not in this workspace");
    }
    const type = String(row.metadata.type ?? "");
    const eventKey = String(row.metadata.eventKey ?? "");
    if (!eventKey) throw new AppError("CONFLICT", "This dead letter has no event key");
    const handler = handlers.get(type);
    if (!handler) throw new AppError("CONFLICT", "Nothing in this process can replay that event");
    const busEvent: BusEvent = {
      tenantId: input.orgId,
      idempotencyKey: eventKey,
      type,
      source: "replay",
      integration: String(row.metadata.integration ?? "") || undefined,
      payload: {},
    };
    return { busEvent, handler, deadLetterId: row.id };
  });
  const result = await runEvent(event.busEvent, event.handler, { journal: auditJournal() });
  const ok = result.status === "done" || result.status === "duplicate";
  await inOrg(input.orgId, async (tx) => {
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "ops.dead_letter.replay",
      target: `audit:${event.deadLetterId}`,
      tier: 1,
      outcome: ok ? "success" : "error",
      metadata: { type: event.busEvent.type, status: result.status },
    });
    if (ok) {
      await recordAudit(tx, {
        tenantId: input.orgId,
        actorType: "user",
        actorId: input.actorUserId,
        action: "ops.dead_letter.resolved",
        target: `audit:${event.deadLetterId}`,
        tier: 1,
        outcome: "success",
        metadata: { deadLetterId: event.deadLetterId, eventKey: event.busEvent.idempotencyKey },
      });
    }
  });
  return result;
}
