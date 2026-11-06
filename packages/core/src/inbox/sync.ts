import { eq } from "drizzle-orm";
import { conversations, emailIdentities, messages, QUEUES, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { getBoss } from "../engine/queue";
import { getEngine } from "../engine/runtime";
import { AppError } from "../errors";
import type { InboundMessage } from "../integrations/mail";
import { logger } from "../logger";
import { inOrg } from "../org/access";
import { noteInboundEmail } from "../scout/lifecycle";
import { withSpan } from "../tracing";
import type { Mailbox } from "./mailbox";

/** Payload of the self-perpetuating background sync job. */
export interface InboxSyncJob {
  tenantId: string;
  identityId: string;
}

const DEFAULT_SYNC_SECONDS = 300;

/** Background pull cadence. WOS_INBOX_SYNC_SECONDS overrides; floor 30s so a typo can't hammer a provider. */
export function inboxSyncIntervalSeconds(): number {
  const raw = Number(process.env.WOS_INBOX_SYNC_SECONDS);
  return Number.isFinite(raw) && raw >= 30 ? Math.floor(raw) : DEFAULT_SYNC_SECONDS;
}

/**
 * Enqueues one inbox sync inside the caller's transaction. singletonKey +
 * singletonSeconds mean a mailbox has at most one waiting job per interval,
 * so reconnects and beats can't pile up duplicates.
 */
export async function enqueueInboxSync(tx: Tx, job: InboxSyncJob, opts: { startAfterSeconds?: number } = {}): Promise<void> {
  const boss = await getBoss();
  await boss.send(QUEUES.inboxSync, job, {
    singletonKey: `inbox-sync:${job.identityId}`,
    singletonSeconds: inboxSyncIntervalSeconds(),
    startAfter: opts.startAfterSeconds,
    db: { executeSql: (text: string, values?: unknown[]) => tx.raw.query(text, values as unknown[]) },
  });
}

function upsertMessage(tx: Tx, tenantId: string, identityId: string, m: InboundMessage): Promise<number> {
  return (async () => {
    const [conv] = await tx
      .insert(conversations)
      .values({ tenantId, emailIdentityId: identityId, subject: m.subject.slice(0, 500), externalThreadId: m.threadId, lastMessageAt: m.sentAt })
      .onConflictDoUpdate({
        target: [conversations.tenantId, conversations.channel, conversations.externalThreadId],
        set: { lastMessageAt: m.sentAt, updatedAt: new Date() },
      })
      .returning({ id: conversations.id });
    const inserted = await tx
      .insert(messages)
      .values({ tenantId, conversationId: conv!.id, direction: m.direction, sender: m.from.slice(0, 500), recipients: m.to.slice(0, 50), subject: m.subject.slice(0, 500), body: m.body.slice(0, 100000), externalId: m.externalId, rfc822MessageId: m.rfc822MessageId ?? null, sentAt: m.sentAt })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    // Scout-specific: a new inbound email may reactivate a lead / update lifecycle.
    if (inserted.length && m.direction === "inbound") await noteInboundEmail(tx, tenantId, m.from, { messageId: m.externalId, sentAt: m.sentAt });
    return inserted.length;
  })();
}

async function resolveMailbox(orgId: string): Promise<Mailbox | null> {
  const resolver = getEngine().mailbox;
  return resolver ? resolver(orgId) : null;
}

async function pullFromMailbox(orgId: string, box: Mailbox, actor: { type: "user" | "system"; id: string }, max: number): Promise<{ newMessages: number; mock: boolean }> {
  const { messages: incoming, cursor } = await box.provider.listRecent({ cursor: box.identity.syncCursor, max });
  const added = await inOrg(orgId, async (tx) => {
    let n = 0;
    for (const m of incoming) n += await upsertMessage(tx, orgId, box.identity.id, m);
    await tx.update(emailIdentities).set({ syncCursor: cursor, lastSyncedAt: new Date() }).where(eq(emailIdentities.id, box.identity.id));
    await recordAudit(tx, { tenantId: orgId, actorType: actor.type, actorId: actor.id, action: "inbox.sync", tier: 0, outcome: "success", metadata: { fetched: incoming.length, added: n, mock: box.provider.mock, background: actor.type === "system" } });
    return n;
  });
  logger.info({ tenantId: orgId, fetched: incoming.length, added, background: actor.type === "system" }, "inbox synced");
  return { newMessages: added, mock: box.provider.mock };
}

/** Pulls new mail into conversations/messages. Idempotent: messages are unique by provider id. */
export async function pullMailbox(orgId: string, actor: { type: "user" | "system"; id: string }, max = 50): Promise<{ newMessages: number; mock: boolean }> {
  const box = await resolveMailbox(orgId);
  if (!box) throw new AppError("NOT_FOUND", "No mailbox is connected");
  return pullFromMailbox(orgId, box, actor, max);
}

/**
 * One beat of the background sync chain. Stops the chain (no re-enqueue) when
 * the mailbox was disconnected; otherwise syncs and schedules the next beat.
 * Provider failures are logged and retried on the next beat rather than
 * crashing the worker into pg-boss retries.
 */
export async function handleInboxSyncJob(job: InboxSyncJob): Promise<void> {
  await withSpan("inbox.sync.job", { "org.id": job.tenantId }, async () => {
    const identity = await inOrg(job.tenantId, async (tx) => (await tx.select({ id: emailIdentities.id }).from(emailIdentities).where(eq(emailIdentities.id, job.identityId)))[0]);
    if (!identity) {
      logger.info({ tenantId: job.tenantId, identityId: job.identityId }, "background inbox sync stopped: mailbox disconnected");
      return;
    }
    const box = await resolveMailbox(job.tenantId);
    if (box) {
      try {
        await pullFromMailbox(job.tenantId, box, { type: "system", id: "inbox-sync" }, 50);
      } catch (err) {
        logger.warn({ tenantId: job.tenantId, err }, "background inbox sync failed; will retry next beat");
      }
    } else {
      logger.warn({ tenantId: job.tenantId }, "background inbox sync: no resolvable mailbox");
    }
    await inOrg(job.tenantId, (tx) => enqueueInboxSync(tx, job, { startAfterSeconds: inboxSyncIntervalSeconds() }));
  });
}

let syncWorkerId: string | undefined;

/** Starts the background inbox-sync worker in this process. */
export async function startInboxSyncWorker(opts: { pollingIntervalSeconds?: number } = {}): Promise<void> {
  const boss = await getBoss();
  syncWorkerId = await boss.work<InboxSyncJob>(QUEUES.inboxSync, { batchSize: 1, pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 5 }, async (jobs) => {
    for (const job of jobs) await handleInboxSyncJob(job.data);
  });
}

export async function stopInboxSyncWorker(): Promise<void> {
  if (!syncWorkerId) return;
  const boss = await getBoss();
  await boss.offWork(QUEUES.inboxSync, { id: syncWorkerId, wait: true });
  syncWorkerId = undefined;
}
