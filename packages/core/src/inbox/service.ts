import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { conversations, emailIdentities, isUuid, messages } from "@wos/db";
import { recordAudit } from "../audit";
import { getEngine } from "../engine/runtime";
import { createTask } from "../engine/tasks";
import { AppError } from "../errors";
import { upsertConnection } from "../integrations/connections";
import type { GoogleTokens } from "../integrations/gmail";
import { ANY_ROLE, inOrg, MANAGERS, requireRole, STAFF } from "../org/access";
import { gateOutboundMail, outboundRecipients, replyRecipients, replySubject, snapshotFromDraft } from "../tools/inbox";
import { enqueueInboxSync, pullMailbox } from "./sync";

/** Stores a Google mailbox after OAuth. Owners and admins only; starts in draft-only mode. */
export async function connectGoogleMailbox(input: { actorUserId: string; orgId: string; address: string; tokens: GoogleTokens; scopes: string[] }) {
  const address = z.email().parse(input.address.toLowerCase());
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "integration.connect");
    if (!input.tokens.refresh_token) throw new AppError("VALIDATION", "Google did not return a refresh token. Remove the app's access in your Google account and connect again.");
    const conn = await upsertConnection(tx, { tenantId: input.orgId, provider: "google", accountLabel: address, scopes: input.scopes, secret: input.tokens, createdBy: input.actorUserId });
    const [existing] = await tx.select().from(emailIdentities).where(eq(emailIdentities.address, address));
    let identityId = existing?.id;
    if (!identityId) {
      const [ins] = await tx.insert(emailIdentities).values({ tenantId: input.orgId, integrationConnectionId: conn.id, address }).returning({ id: emailIdentities.id });
      identityId = ins!.id;
    }
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "integration.connect", target: `integration:${conn.id}`, tier: 4, outcome: "success", metadata: { provider: "google", address, scopes: input.scopes } });
    // Kick off the self-perpetuating background sync for this mailbox.
    await enqueueInboxSync(tx, { tenantId: input.orgId, identityId });
    return { connectionId: conn.id };
  });
}

/** Switching a mailbox to allow sending is a privileged change: owners only, audited. */
export async function setMailboxMode(input: { actorUserId: string; orgId: string; identityId: string; mode: "draft_only" | "send_with_approval" }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ["owner"], "mailbox.set_mode");
    const r = isUuid(input.identityId)
      ? await tx.update(emailIdentities).set({ mode: input.mode }).where(eq(emailIdentities.id, input.identityId)).returning({ id: emailIdentities.id })
      : [];
    if (!r.length) throw new AppError("NOT_FOUND", "Mailbox not found");
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "mailbox.set_mode", target: `email_identity:${input.identityId}`, tier: 4, outcome: "success", metadata: { mode: input.mode } });
    return { mode: input.mode };
  });
}

export async function listMailboxes(input: { actorUserId: string; orgId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "mailbox.list");
    return tx.select().from(emailIdentities);
  });
}

/** Manual pull. The background chain (inbox/sync.ts) keeps mail flowing between clicks. */
export async function syncInbox(input: { actorUserId: string; orgId: string; max?: number }): Promise<{ newMessages: number; mock: boolean }> {
  await inOrg(input.orgId, (tx) => requireRole(tx, input.orgId, input.actorUserId, STAFF, "inbox.sync"));
  return pullMailbox(input.orgId, { type: "user", id: input.actorUserId }, input.max ?? 50);
}

export async function listConversations(input: { actorUserId: string; orgId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "inbox.list");
    return tx.select().from(conversations).orderBy(desc(conversations.lastMessageAt)).limit(100);
  });
}

export async function getConversation(input: { actorUserId: string; orgId: string; conversationId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "inbox.get");
    const [conv] = isUuid(input.conversationId) ? await tx.select().from(conversations).where(eq(conversations.id, input.conversationId)) : [];
    if (!conv) throw new AppError("NOT_FOUND", "Conversation not found");
    const msgs = await tx.select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(messages.sentAt);
    return { conversation: conv, messages: msgs };
  });
}

/**
 * Asks the inbox agent to categorize a conversation and draft a reply. The
 * email content goes to the model as wrapped external data (see orchestrator).
 */
export async function triageConversation(input: { actorUserId: string; orgId: string; conversationId: string }) {
  const { conversation, messages: msgs } = await getConversation(input);
  const recent = msgs.slice(-5).map((m) => ({ direction: m.direction, from: m.sender, sentAt: m.sentAt.toISOString(), body: m.body.slice(0, 4000) }));
  return createTask({
    actorUserId: input.actorUserId,
    orgId: input.orgId,
    title: `Triage email: ${conversation.subject || "(no subject)"}`,
    intent: `Triage this email conversation: set a category and summary with inbox.categorize, and draft a helpful reply with inbox.create_draft. Conversation id: ${conversation.id}`,
    input: { agentKind: "inbox", conversationId: conversation.id, subject: conversation.subject, messages: recent },
  });
}

/** Requests sending the current draft. Always a tier 2 approval; the approval shows the exact email. */
export async function requestSendDraft(input: { actorUserId: string; orgId: string; conversationId: string }) {
  const { conversation, messages: msgs } = await getConversation(input);
  if (!conversation.draftExternalId || !conversation.draftBody) throw new AppError("CONFLICT", "There is no draft to send");
  const lastInbound = [...msgs].reverse().find((m) => m.direction === "inbound");
  const args = {
    conversationId: conversation.id,
    to: replyRecipients(lastInbound),
    subject: replySubject(conversation.subject),
    body: conversation.draftBody,
    draftExternalId: conversation.draftExternalId,
    draftMessageId: conversation.draftMessageId,
  };
  // Say so now rather than after someone approves it. The send tool checks the provider draft again at send time.
  const box = await getEngine().mailbox?.(input.orgId);
  const live = box && conversation.draftMessageId ? await box.provider.findDraft(conversation.draftMessageId) : undefined;
  const snap = live && conversation.draftMessageId && live.draftId === conversation.draftExternalId ? snapshotFromDraft(conversation.id, conversation.draftMessageId, live) : null;
  const recipients = snap ? outboundRecipients(snap) : args.to;
  const gate = await inOrg(input.orgId, (tx) => gateOutboundMail(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, target: `conversation:${conversation.id}`, recipients }));
  if (!gate.allowed) throw new AppError("CONFLICT", gate.message);
  return createTask({
    actorUserId: input.actorUserId,
    orgId: input.orgId,
    title: `Send reply to ${args.to.join(", ")}: ${args.subject}`,
    intent: `Send the drafted reply: ${args.subject}`,
    direct: { agentKind: "inbox", steps: [{ tool: "inbox.send_draft", args }] },
  });
}
