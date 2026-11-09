import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { CONVERSATION_CATEGORIES, conversations, messages, withTenant } from "@wos/db";
import { recordAudit } from "../audit";
import { canonicalJson } from "../engine/digest";
import { getEngine } from "../engine/runtime";
import { objectResult, ToolError, type ToolContext, type ToolDefinition, type ToolRegistry } from "../engine/tools";
import { messageIdFor, type MailAttachment, type MailDraft } from "../integrations/mail";
import type { MailboxResolver } from "../inbox/mailbox";
import { produceIntegration } from "../events/produce";
import { checkEmailAllowed, normalizeAddress, recordOutreach, type SendCheck } from "../scout/consent";
import type { Tx } from "@wos/db";

const conversationId = z.uuid();

async function loadThread(ctx: ToolContext, id: string) {
  return withTenant(ctx.tenantId, async (tx) => {
    const [conv] = await tx.select().from(conversations).where(eq(conversations.id, id));
    if (!conv) throw new ToolError("Conversation not found", false, "NOT_FOUND");
    const [lastInbound] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, id), eq(messages.direction, "inbound")))
      .orderBy(desc(messages.sentAt))
      .limit(1);
    return { conv, lastInbound };
  });
}

/** Reply recipients come from the thread, never from model output. */
export function replyRecipients(lastInbound: { sender: string } | undefined): string[] {
  if (!lastInbound) return [];
  const m = lastInbound.sender.match(/<([^>]+)>/);
  return [(m?.[1] ?? lastInbound.sender).trim().toLowerCase()];
}

export const replySubject = (subject: string) => (/^re:/i.test(subject) ? subject : `Re: ${subject}`);

export interface SendDraftSnapshot {
  conversationId: string;
  draftExternalId: string;
  draftMessageId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  body: string;
  attachments: MailAttachment[];
}

function addressKey(value: string): string {
  const wrapped = value.match(/<([^>]+)>/);
  return (wrapped?.[1] ?? value).trim().toLowerCase();
}

function addressKeys(list: string[] | undefined): string[] {
  return [...(list ?? [])].map(addressKey).filter(Boolean).sort();
}

function attachmentKeys(list: MailAttachment[] | undefined): MailAttachment[] {
  return [...(list ?? [])]
    .map((a) => ({ filename: a.filename, contentType: a.contentType, sha256: a.sha256, size: a.size }))
    .sort((a, b) => a.sha256.localeCompare(b.sha256) || a.filename.localeCompare(b.filename) || a.size - b.size);
}

/** The provider draft, normalized so a later read can be compared byte for byte. */
export function snapshotFromDraft(conversationId: string, draftMessageId: string, live: MailDraft): SendDraftSnapshot | null {
  if (!live.to?.length || live.subject === undefined || live.body === undefined) return null;
  return {
    conversationId,
    draftExternalId: live.draftId,
    draftMessageId,
    to: addressKeys(live.to),
    cc: addressKeys(live.cc),
    bcc: addressKeys(live.bcc),
    replyTo: addressKeys(live.replyTo),
    subject: live.subject,
    body: live.body,
    attachments: attachmentKeys(live.attachments),
  };
}

/** Hash of the exact mailbox action a person approves. Execution must recompute this from the provider. */
export function sendContentHash(action: SendDraftSnapshot): string {
  return createHash("sha256").update(canonicalJson({
    conversationId: action.conversationId,
    draftExternalId: action.draftExternalId,
    draftMessageId: action.draftMessageId,
    to: action.to,
    cc: action.cc,
    bcc: action.bcc,
    replyTo: action.replyTo,
    subject: action.subject,
    body: action.body,
    attachments: action.attachments,
  })).digest("hex");
}

function sameAddresses(left: string[] | undefined, right: string[]): boolean {
  return left === undefined || addressKeys(left).join("\n") === addressKeys(right).join("\n");
}

/** Every address this draft would contact. Reply-To is included: it names who should be written back. */
export function outboundRecipients(action: { to: string[]; cc?: string[]; bcc?: string[]; replyTo?: string[] }): string[] {
  return [...new Set([...addressKeys(action.to), ...addressKeys(action.cc), ...addressKeys(action.bcc), ...addressKeys(action.replyTo)])];
}

/**
 * Do-not-contact and Scout permission for every recipient on the draft.
 * One blocked address refuses the whole send. Each block is audited.
 * SMS quiet hours are not an email-header check; speed-to-lead email is a single address and uses the same permission check.
 */
export async function gateOutboundMail(tx: Tx, input: { tenantId: string; actorType: "user" | "agent" | "system"; actorId: string; target: string; recipients: string[] }): Promise<SendCheck> {
  const recipients = [...new Set(input.recipients.map(normalizeAddress).filter(Boolean))];
  let denied: Extract<SendCheck, { allowed: false }> | null = null;
  const opportunityIds = new Map<string, string>();
  for (const recipient of recipients) {
    const gate = await checkEmailAllowed(tx, [recipient]);
    if (!gate.allowed) {
      denied ??= gate;
      await recordOutreach(tx, { tenantId: input.tenantId, opportunityId: gate.opportunityId, recipient: gate.recipient, kind: "blocked", reason: gate.reason, actor: { type: input.actorType, id: input.actorId }, ref: input.target });
      await recordAudit(tx, { tenantId: input.tenantId, actorType: input.actorType, actorId: input.actorId, action: "inbox.send.blocked", target: input.target, tier: 2, outcome: "denied", metadata: { recipient: gate.recipient, reason: gate.reason, recipients } });
    } else {
      for (const [email, opp] of gate.opportunityIds) opportunityIds.set(email, opp);
    }
  }
  if (denied) return denied;
  return { allowed: true, opportunityIds };
}

/**
 * The draft the mailbox will actually send, not the model's claimed recipient.
 * Returns null when that draft cannot be read.
 */
export async function bindSendDraftArgs(tenantId: string, proposed: { conversationId: string; to?: string[]; cc?: string[]; bcc?: string[]; replyTo?: string[]; subject?: string; body?: string; draftExternalId?: string; draftMessageId?: string; attachments?: MailAttachment[] }): Promise<(SendDraftSnapshot & { contentHash: string }) | null> {
  const box = await getEngine().mailbox?.(tenantId);
  if (!box) return null;
  let conv;
  let lastInbound;
  try {
    ({ conv, lastInbound } = await loadThread({ tenantId, taskId: "bind", agentId: "bind", idempotencyKey: "bind" }, proposed.conversationId));
  } catch {
    return null;
  }
  const draftMessageId = proposed.draftMessageId ?? conv.draftMessageId ?? undefined;
  const draftExternalId = proposed.draftExternalId ?? conv.draftExternalId ?? undefined;
  if (!draftMessageId || !draftExternalId) return null;
  const live = await box.provider.findDraft(draftMessageId);
  if (!live || live.draftId !== draftExternalId) return null;
  const resolved = snapshotFromDraft(conv.id, draftMessageId, live);
  if (!resolved) return null;
  if (!replyRecipients(lastInbound).length) return null;
  const sameFiles = proposed.attachments === undefined || canonicalJson(attachmentKeys(proposed.attachments)) === canonicalJson(resolved.attachments);
  if (
    !sameAddresses(proposed.to, resolved.to) ||
    !sameAddresses(proposed.cc, resolved.cc) ||
    !sameAddresses(proposed.bcc, resolved.bcc) ||
    !sameAddresses(proposed.replyTo, resolved.replyTo) ||
    (proposed.subject !== undefined && proposed.subject !== resolved.subject) ||
    (proposed.body !== undefined && proposed.body !== resolved.body) ||
    !sameFiles
  ) return null;
  return { ...resolved, contentHash: sendContentHash(resolved) };
}

export function inboxTools(mailbox: MailboxResolver): ToolDefinition[] {
  const categorize: ToolDefinition<{ conversationId: string; category: (typeof CONVERSATION_CATEGORIES)[number]; summary: string }> = {
    name: "inbox.categorize",
    description: "Set the category and a one-paragraph summary on an email conversation.",
    tier: 1,
    output: objectResult,
    rate: { limit: 60, windowMs: 60_000 },
    args: z.object({ conversationId, category: z.enum(CONVERSATION_CATEGORIES), summary: z.string().trim().min(1).max(600) }),
    summarize: (a) => `Mark conversation as ${a.category}`,
    async execute(ctx, a) {
      await withTenant(ctx.tenantId, async (tx) => {
        const r = await tx
          .update(conversations)
          .set({ category: a.category, summary: a.summary, updatedAt: new Date() })
          .where(eq(conversations.id, a.conversationId))
          .returning({ id: conversations.id });
        if (!r.length) throw new ToolError("Conversation not found", false, "NOT_FOUND");
      });
      return { conversationId: a.conversationId, category: a.category };
    },
  };

  const createDraft: ToolDefinition<{ conversationId: string; body: string }> = {
    name: "inbox.create_draft",
    description: "Write a reply as a draft in the mailbox (not sent). Recipients and subject come from the thread.",
    tier: 1,
    output: objectResult,
    args: z.object({ conversationId, body: z.string().trim().min(1).max(20000) }),
    summarize: (a) => `Draft a reply (${a.body.length} characters)`,
    async execute(ctx, a) {
      const box = await mailbox(ctx.tenantId);
      if (!box) throw new ToolError("No mailbox is connected", false, "NO_MAILBOX");
      const { conv, lastInbound } = await loadThread(ctx, a.conversationId);
      const to = replyRecipients(lastInbound);
      if (!to.length) throw new ToolError("This conversation has no inbound message to reply to", false, "NO_RECIPIENT");
      const messageId = messageIdFor(ctx.idempotencyKey);
      if (await box.provider.findSent(messageId)) throw new ToolError("This draft was already sent. Start a new follow-up.", false, "DRAFT_ALREADY_SENT");
      const { draftId } = await produceIntegration({
        tenantId: ctx.tenantId,
        integration: "mail",
        idempotencyKey: `mail-draft:${ctx.idempotencyKey}`,
        effect: (fx) => fx.once(() => box.provider.createDraft({
        threadId: conv.externalThreadId,
        to,
        subject: replySubject(conv.subject),
        body: a.body,
        inReplyTo: lastInbound?.rfc822MessageId ?? undefined,
        messageId,
      })),
      });
      const live = await box.provider.findDraft(messageId);
      if (!live || live.draftId !== draftId) throw new ToolError("The mailbox draft is not there.", false, "DRAFT_MISSING");
      await withTenant(ctx.tenantId, (tx) =>
        tx.update(conversations).set({ draftExternalId: live.draftId, draftMessageId: messageId, draftBody: a.body, updatedAt: new Date() }).where(eq(conversations.id, conv.id)),
      );
      return { draftId: live.draftId, to, mock: box.provider.mock };
    },
    // createDraft already looks the draft up by Message-ID first, so re-running is safe.
  };

  const sendDraft: ToolDefinition<{ conversationId: string; to: string[]; cc?: string[]; bcc?: string[]; replyTo?: string[]; subject: string; body: string; draftExternalId?: string; draftMessageId?: string; contentHash?: string; attachments?: MailAttachment[] }> = {
    name: "inbox.send_draft",
    description: "Send the drafted reply in a conversation. The approval shows exactly what goes out.",
    tier: 2,
    output: z.object({ externalId: z.string(), to: z.array(z.string()) }),
    rate: { limit: 20, windowMs: 60_000 },
    args: z.object({
      conversationId,
      to: z.array(z.email()).min(1).max(20),
      cc: z.array(z.email()).max(20).optional(),
      bcc: z.array(z.email()).max(20).optional(),
      replyTo: z.array(z.email()).max(20).optional(),
      subject: z.string().max(500),
      body: z.string().max(20000),
      draftExternalId: z.string().min(1).max(200).optional(),
      draftMessageId: z.string().min(1).max(300).optional(),
      contentHash: z.string().length(64).optional(),
      attachments: z.array(z.object({
        filename: z.string().max(300),
        contentType: z.string().max(200),
        sha256: z.string().length(64),
        size: z.number().int().nonnegative(),
      })).max(20).optional(),
    }),
    summarize: (a) => {
      const copies = [
        a.cc?.length ? `cc ${a.cc.join(", ")}` : "",
        a.bcc?.length ? `bcc ${a.bcc.join(", ")}` : "",
        a.replyTo?.length ? `reply-to ${a.replyTo.join(", ")}` : "",
        a.attachments?.length ? `${a.attachments.length} attachment${a.attachments.length === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      const extra = copies.length ? ` (${copies.join("; ")})` : "";
      return `Send email to ${a.to.join(", ")}${extra}: "${a.subject}"`;
    },
    async execute(ctx, a) {
      const box = await mailbox(ctx.tenantId);
      if (!box) throw new ToolError("No mailbox is connected", false, "NO_MAILBOX");
      if (box.identity.mode !== "send_with_approval") {
        throw new ToolError("This mailbox is in draft-only mode. An owner can allow sending in Settings.", false, "DRAFT_ONLY");
      }
      const { conv, lastInbound } = await loadThread(ctx, a.conversationId);
      const expectedTo = replyRecipients(lastInbound);
      const pinnedId = a.draftExternalId ?? conv.draftExternalId;
      const pinnedMessageId = a.draftMessageId ?? conv.draftMessageId;
      const live = pinnedMessageId ? await box.provider.findDraft(pinnedMessageId) : undefined;
      const resolved = live && live.draftId === pinnedId && pinnedMessageId ? snapshotFromDraft(conv.id, pinnedMessageId, live) : null;
      if (!pinnedId || !pinnedMessageId || !resolved || resolved.draftExternalId !== pinnedId) {
        throw new ToolError("The mailbox draft is gone. Request a new approval.", false, "DRAFT_MISSING");
      }
      const approved = {
        to: addressKeys(a.to),
        cc: addressKeys(a.cc),
        bcc: addressKeys(a.bcc),
        replyTo: addressKeys(a.replyTo),
        attachments: attachmentKeys(a.attachments),
      };
      const hash = sendContentHash(resolved);
      const threadTo = addressKeys(expectedTo);
      if (
        (a.contentHash !== undefined && a.contentHash !== hash) ||
        canonicalJson(approved) !== canonicalJson({ to: resolved.to, cc: resolved.cc, bcc: resolved.bcc, replyTo: resolved.replyTo, attachments: resolved.attachments }) ||
        resolved.subject !== a.subject ||
        resolved.body !== a.body ||
        resolved.draftExternalId !== pinnedId ||
        resolved.conversationId !== a.conversationId ||
        threadTo.join("\n") !== approved.to.join("\n")
      ) {
        throw new ToolError("The draft changed after it was approved. Request a new approval.", false, "DRAFT_CHANGED");
      }
      // Do-not-contact and Scout consent, checked against the provider draft after approval.
      const gate = await withTenant(ctx.tenantId, (tx) => gateOutboundMail(tx, {
        tenantId: ctx.tenantId,
        actorType: "agent",
        actorId: ctx.agentId,
        target: `task:${ctx.taskId}`,
        recipients: outboundRecipients(resolved),
      }));
      if (!gate.allowed) throw new ToolError(gate.message, false, gate.reason === "suppressed" ? "SUPPRESSED" : "NO_PERMISSION");
      const { externalId } = await produceIntegration({
        tenantId: ctx.tenantId,
        integration: "mail",
        idempotencyKey: `mail-send:${ctx.idempotencyKey}`,
        mock: box.provider.mock,
        retry: box.provider.mock
          ? async () => {
              const again = await box.provider.sendDraft(pinnedId);
              return { externalId: again.externalId, mock: true };
            }
          : undefined,
        effect: (fx) => fx.once(() => box.provider.sendDraft(pinnedId)),
      });
      const sent = await recordSent(ctx, conv.id, externalId, { to: [...resolved.to, ...resolved.cc, ...resolved.bcc], subject: resolved.subject, body: resolved.body }, box.identity.address, pinnedMessageId);
      if (gate.opportunityIds.size) {
        await withTenant(ctx.tenantId, async (tx) => {
          for (const [to, opp] of gate.opportunityIds) await recordOutreach(tx, { tenantId: ctx.tenantId, opportunityId: opp, recipient: to, kind: "sent", actor: { type: "agent", id: ctx.agentId }, ref: externalId });
        });
      }
      return sent;
    },
    async reconcile(ctx, a) {
      const box = await mailbox(ctx.tenantId);
      const { conv } = await loadThread(ctx, a.conversationId);
      const messageId = a.draftMessageId ?? conv.draftMessageId;
      if (!box || !messageId) return undefined;
      const sent = await box.provider.findSent(messageId);
      if (!sent) return undefined;
      const already = await withTenant(ctx.tenantId, async (tx) => {
        const [row] = await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.conversationId, conv.id), eq(messages.rfc822MessageId, messageId), eq(messages.direction, "outbound"))).limit(1);
        return row;
      });
      if (already) return undefined;
      return recordSent(ctx, conv.id, sent.externalId, a, box.identity.address, messageId);
    },
  };

  return [categorize, createDraft, sendDraft] as ToolDefinition[];
}

async function recordSent(
  ctx: ToolContext,
  convId: string,
  externalId: string,
  a: { to: string[]; subject: string; body: string },
  from: string,
  rfc822MessageId: string | null,
) {
  await withTenant(ctx.tenantId, async (tx) => {
    await tx
      .insert(messages)
      .values({ tenantId: ctx.tenantId, conversationId: convId, direction: "outbound", sender: from, recipients: a.to, subject: a.subject, body: a.body, externalId, rfc822MessageId, sentAt: new Date() })
      .onConflictDoNothing();
    await tx.update(conversations).set({ lastMessageAt: new Date(), updatedAt: new Date() }).where(eq(conversations.id, convId));
    if (rfc822MessageId) {
      await tx.update(conversations).set({ draftExternalId: null, draftBody: null, draftMessageId: null }).where(and(eq(conversations.id, convId), eq(conversations.draftMessageId, rfc822MessageId)));
    }
  });
  return { externalId, to: a.to };
}

export function registerInboxTools(registry: ToolRegistry, mailbox: MailboxResolver): void {
  registry.register(...inboxTools(mailbox));
}
