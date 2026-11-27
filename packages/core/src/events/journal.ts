import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { auditEvents, deadLetters, integrationEvents, withTenant } from "@wos/db";
import { recordAudit } from "../audit";
import { scrubPii } from "../logger";
import type { ClaimRequest, ClaimResult, DeadLetter, EventJournal, JournalEntry } from "./bus";

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
 * Durable events (0022 tables) are the default now that 0022 is adopted.
 * WOS_DURABLE_EVENTS=0 is a rollback lever: it falls back to the audit-trail
 * journal and in-process breaker (use it only if 0022 has been rolled back).
 */
export function durableEventsEnabled(): boolean {
  return process.env.WOS_DURABLE_EVENTS !== "0";
}

export function durableJournal(): EventJournal {
  return {
    // Only a FINISHED event counts. A row in 'in_progress' (a worker is running it, or died
    // holding the lease) or 'failed' is decided by claim(), not by this early check.
    async has(tenantId, key) {
      return withTenant(tenantId, async (tx) => {
        const [row] = await tx
          .select({ id: integrationEvents.id })
          .from(integrationEvents)
          .where(and(eq(integrationEvents.idempotencyKey, key), inArray(integrationEvents.status, ["done", "skipped", "dead"])));
        return !!row;
      });
    },
    /**
     * One statement, so exactly one caller wins: insert the claim, or take over a row that
     * is 'failed' or whose lease has run out. Lease times come from the database clock
     * (now()), not from each process's, so clock skew between workers cannot shorten a lease.
     * No row back means the key is finished or another caller's lease is still live.
     */
    async claim(req: ClaimRequest): Promise<ClaimResult> {
      return withTenant(req.tenantId, async (tx) => {
        const won = await tx.execute(sql`
          INSERT INTO integration_events (tenant_id, idempotency_key, type, source, status, lease_owner, lease_expires_at, attempts)
          VALUES (${req.tenantId}, ${req.key}, ${req.type.slice(0, 80)}, ${req.source.slice(0, 80)}, 'in_progress',
                  ${req.owner}, now() + (${Math.max(1, Math.floor(req.leaseMs))} * interval '1 millisecond'), 1)
          ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
            SET status = 'in_progress',
                lease_owner = EXCLUDED.lease_owner,
                lease_expires_at = EXCLUDED.lease_expires_at,
                attempts = integration_events.attempts + 1
            WHERE integration_events.status = 'failed'
               OR (integration_events.status = 'in_progress' AND integration_events.lease_expires_at < now())
          RETURNING id`);
        if (won.rows.length) return "claimed";
        const [row] = await tx
          .select({ status: integrationEvents.status })
          .from(integrationEvents)
          .where(eq(integrationEvents.idempotencyKey, req.key));
        return row?.status === "in_progress" ? "busy" : "completed";
      });
    },
    /** Ends the claim. Matches on the owner, so a worker whose lease expired cannot overwrite its successor. */
    async finish(input) {
      const rows = await withTenant(input.tenantId, (tx) =>
        tx
          .update(integrationEvents)
          // `attempts` counts claims (claim() increments it); finishing must not overwrite it.
          .set({ status: input.outcome === "done" ? "done" : "failed", leaseOwner: null, leaseExpiresAt: null })
          .where(
            and(
              eq(integrationEvents.idempotencyKey, input.key),
              eq(integrationEvents.leaseOwner, input.owner),
              eq(integrationEvents.status, "in_progress"),
            ),
          )
          .returning({ id: integrationEvents.id }),
      );
      return rows.length === 1;
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
