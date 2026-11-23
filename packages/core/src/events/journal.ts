import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditEvents, proposedSchema, withTenant } from "@wos/db";

// Pending proposed 0022 tables (see packages/db/src/schema-proposed.ts); used only when WOS_DURABLE_EVENTS=1.
const { deadLetters, integrationEvents } = proposedSchema;
import { recordAudit } from "../audit";
import { scrubPii } from "../logger";
import type { DeadLetter, EventJournal, JournalEntry } from "./bus";

/** Short stable id. The full event key is stored in metadata, never truncated. */
export function deadLetterIdempotencyKey(eventKey: string): string {
  return `dlq:${createHash("sha256").update(eventKey).digest("hex")}`;
}

function redactStored(value: string): string {
  const scrubbed = scrubPii(value);
  return (typeof scrubbed === "string" ? scrubbed : "error").slice(0, 200);
}

function duplicate(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  return e?.code === "23505" || e?.cause?.code === "23505" || /duplicate key/i.test(e?.message ?? "");
}

/**
 * Durable journal on the 0022 tables: `integration_events` records applied (or
 * deliberately skipped) event keys; `dead_letters` holds failures until a
 * manager replays them. State is shared by every web and worker process, so a
 * replayed or duplicated event is dropped no matter which process sees it.
 * An audit row is still written for each dead letter (tamper-evident trail).
 */
/**
 * Durable events (0022 tables) are opt-in until the owner reviews and adopts
 * packages/db/proposed/0022_events_and_dead_letters.sql. Default: audit-trail
 * journal and in-process breaker, which need no new tables.
 */
export function durableEventsEnabled(): boolean {
  return process.env.WOS_DURABLE_EVENTS === "1";
}

export function durableJournal(): EventJournal {
  return {
    async has(tenantId, key) {
      return withTenant(tenantId, async (tx) => {
        const [row] = await tx
          .select({ id: integrationEvents.id })
          .from(integrationEvents)
          .where(and(eq(integrationEvents.idempotencyKey, key)));
        return !!row;
      });
    },
    async put(entry: JournalEntry) {
      try {
        const rows = await withTenant(entry.tenantId, (tx) =>
          tx
            .insert(integrationEvents)
            .values({
              tenantId: entry.tenantId,
              idempotencyKey: entry.key,
              type: entry.type.slice(0, 80),
              source: entry.source.slice(0, 80),
              status: entry.status ?? "done",
            })
            .onConflictDoNothing({ target: [integrationEvents.tenantId, integrationEvents.idempotencyKey] })
            .returning({ id: integrationEvents.id }),
        );
        return rows.length ? "inserted" : "duplicate";
      } catch (err) {
        if (duplicate(err)) return "duplicate";
        throw err;
      }
    },
    async dead(entry: DeadLetter) {
      const error = redactStored(entry.error).slice(0, 300);
      // Durable row first, in its own transaction: a re-dead-lettered key must
      // still refresh the row even when the audit insert below dedupes.
      await withTenant(entry.tenantId, (tx) =>
        tx
          .insert(deadLetters)
          .values({
            tenantId: entry.tenantId,
            eventKey: entry.key,
            type: entry.type.slice(0, 80),
            source: entry.source.slice(0, 80),
            integration: (entry.integration ?? "").slice(0, 80),
            error,
            attempts: entry.attempts,
          })
          .onConflictDoUpdate({
            target: [deadLetters.tenantId, deadLetters.eventKey],
            set: { error, attempts: entry.attempts, replayedAt: null },
          }),
      );
      // Audit trail row (tamper-evident chain). The dlq: idempotency key makes a
      // repeated dead letter a no-op here; the durable row above already updated.
      await withTenant(entry.tenantId, (tx) =>
        recordAudit(tx, {
          tenantId: entry.tenantId,
          actorType: "system",
          actorId: "event-bus",
          action: "ops.dead_letter",
          target: entry.type,
          tier: 0,
          outcome: "error",
          idempotencyKey: deadLetterIdempotencyKey(entry.key),
          metadata: {
            type: entry.type,
            source: entry.source,
            integration: entry.integration ?? "",
            eventKey: entry.key,
            error,
            attempts: entry.attempts,
          },
        }),
      ).catch((err) => {
        if (!duplicate(err)) throw err;
      });
    },
  };
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
            idempotencyKey: deadLetterIdempotencyKey(entry.key),
            metadata: {
              type: entry.type,
              source: entry.source,
              integration: entry.integration ?? "",
              eventKey: entry.key,
              error: redactStored(entry.error),
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

/** The journal for the current mode: durable tables when opted in, else the audit trail. */
export function activeJournal(): EventJournal {
  return durableEventsEnabled() ? durableJournal() : auditJournal();
}
