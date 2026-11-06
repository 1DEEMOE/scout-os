import { and, eq } from "drizzle-orm";
import { auditEvents, withTenant } from "@wos/db";
import { recordAudit } from "../audit";
import type { DeadLetter, EventJournal, JournalEntry } from "./bus";

function duplicate(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  return e?.code === "23505" || e?.cause?.code === "23505" || /duplicate key/i.test(e?.message ?? "");
}

/** Live journal. Uses the audit log until proposed 0022 is reviewed and applied. */
export function auditJournal(): EventJournal {
  return {
    async has(tenantId, key) {
      return withTenant(tenantId, async (tx) => {
        const [row] = await tx
          .select({ id: auditEvents.id })
          .from(auditEvents)
          .where(and(eq(auditEvents.idempotencyKey, key), eq(auditEvents.action, "ops.event")));
        return !!row;
      });
    },
    async put(entry: JournalEntry) {
      try {
        await withTenant(entry.tenantId, (tx) =>
          recordAudit(tx, {
            tenantId: entry.tenantId,
            actorType: "system",
            actorId: "event-bus",
            action: "ops.event",
            target: entry.type,
            tier: 0,
            outcome: "success",
            idempotencyKey: entry.key,
            metadata: { type: entry.type, source: entry.source, attempt: entry.attempt },
          }),
        );
        return "inserted";
      } catch (err) {
        if (duplicate(err)) return "duplicate";
        throw err;
      }
    },
    async dead(entry: DeadLetter) {
      try {
        await withTenant(entry.tenantId, (tx) =>
          recordAudit(tx, {
            tenantId: entry.tenantId,
            actorType: "system",
            actorId: "event-bus",
            action: "ops.dead_letter",
            target: entry.type,
            tier: 0,
            outcome: "error",
            idempotencyKey: `dlq:${entry.key}`.slice(0, 200),
            metadata: {
              type: entry.type,
              source: entry.source,
              integration: entry.integration ?? "",
              error: entry.error.slice(0, 200),
              attempts: entry.attempts,
            },
          }),
        );
      } catch (err) {
        if (!duplicate(err)) throw err;
      }
    },
  };
}
