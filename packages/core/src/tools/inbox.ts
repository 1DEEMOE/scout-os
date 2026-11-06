import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { CONVERSATION_CATEGORIES, conversations, messages, withTenant } from "@wos/db";
import { objectResult, ToolError, type ToolContext, type ToolDefinition, type ToolRegistry } from "../engine/tools";
import { messageIdFor } from "../integrations/mail";
import type { MailboxResolver } from "../inbox/mailbox";
import { checkEmailAllowed, recordOutreach } from "../scout/consent";

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
      const { draftId } = await box.provider.createDraft({
        threadId: conv.externalThreadId,
        to,
        subject: replySubject(conv.subject),
        body: a.body,
        inReplyTo: lastInbound?.rfc822MessageId ?? undefined,
        messageId,
      });
      await withTenant(ctx.tenantId, (tx) =>
        tx.update(conversations).set({ draftExternalId: draftId, draftMessageId: messageId, draftBody: a.body, updatedAt: new Date() }).where(eq(conversations.id, conv.id)),
      );
      return { draftId, to, mock: box.provider.mock };
    },
    // createDraft already looks the draft up by Message-ID first, so re-running is safe.
  };

  const sendDraft: ToolDefinition<{ conversationId: string; to: string[]; subject: string; body: string }> = {
    name: "inbox.send_draft",
    description: "Send the drafted reply in a conversation. The approval shows exactly what goes out.",
    tier: 2,
    output: z.object({ externalId: z.string(), to: z.array(z.string()) }),
    rate: { limit: 20, windowMs: 60_000 },
    args: z.object({ conversationId, to: z.array(z.email()).min(1).max(20), subject: z.string().max(500), body: z.string().max(20000) }),
    summarize: (a) => `Send email to ${a.to.join(", ")}: "${a.subject}"`,
    async execute(ctx, a) {
      const box = await mailbox(ctx.tenantId);
      if (!box) throw new ToolError("No mailbox is connected", false, "NO_MAILBOX");
      if (box.identity.mode !== "send_with_approval") {
        throw new ToolError("This mailbox is in draft-only mode. An owner can allow sending in Settings.", false, "DRAFT_ONLY");
      }
      const { conv, lastInbound } = await loadThread(ctx, a.conversationId);
      // What was approved must still be exactly what would go out.
      const expectedTo = replyRecipients(lastInbound);
      if (
        !conv.draftExternalId ||
        conv.draftBody !== a.body ||
        replySubject(conv.subject) !== a.subject ||
        expectedTo.join(",") !== a.to.map((t) => t.toLowerCase()).join(",")
      ) {
        throw new ToolError("The draft changed after it was approved. Request a new approval.", false, "DRAFT_CHANGED");
      }
      // Do-not-contact and Scout consent, checked at send time (after approval).
      const gate = await withTenant(ctx.tenantId, async (tx) => {
        const g = await checkEmailAllowed(tx, a.to);
        if (!g.allowed) await recordOutreach(tx, { tenantId: ctx.tenantId, opportunityId: g.opportunityId, recipient: g.recipient, kind: "blocked", reason: g.reason, actor: { type: "agent", id: ctx.agentId }, ref: `task:${ctx.taskId}` });
        return g;
      });
      if (!gate.allowed) throw new ToolError(gate.message, false, gate.reason === "suppressed" ? "SUPPRESSED" : "NO_PERMISSION");
      const { externalId } = await box.provider.sendDraft(conv.draftExternalId);
      const sent = await recordSent(ctx, conv.id, externalId, a, box.identity.address, conv.draftMessageId);
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
      if (!box || !conv.draftMessageId) return undefined;
      const sent = await box.provider.findSent(conv.draftMessageId);
      return sent ? recordSent(ctx, conv.id, sent.externalId, a, box.identity.address, conv.draftMessageId) : undefined;
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
    await tx.update(conversations).set({ draftExternalId: null, draftBody: null, draftMessageId: null, lastMessageAt: new Date(), updatedAt: new Date() }).where(eq(conversations.id, convId));
  });
  return { externalId, to: a.to };
}

export function registerInboxTools(registry: ToolRegistry, mailbox: MailboxResolver): void {
  registry.register(...inboxTools(mailbox));
}
