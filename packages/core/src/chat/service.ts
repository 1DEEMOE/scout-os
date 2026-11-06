import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { chatDelegations, chatMessages, chatThreads, isUuid, tasks, users, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { logger } from "../logger";
import { ANY_ROLE, auditDenied, inOrg, requireRole, STAFF } from "../org/access";
import { agentsPaused } from "../org/pause";
import { loadAgent } from "../engine/agents";
import { getEngine } from "../engine/runtime";
import { insertTask } from "../engine/tasks";
import { externalData, SAFETY_PREAMBLE } from "../engine/orchestrator";
import { DELEGATE_TOOL, delegateArgs, LEAD_BOT_SYSTEM, MAX_DELEGATION_DEPTH, MAX_DELEGATIONS_PER_TURN, type DelegableKind } from "./lead";

export type ChatThreadRow = typeof chatThreads.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;

/** Typed lead bot errors. `message` is safe to show in the UI. */
export class LeadBotError extends AppError {
  constructor(message: string, readonly reason: "MODEL_UNAVAILABLE" | "THREAD_NOT_FOUND") {
    super(reason === "THREAD_NOT_FOUND" ? "NOT_FOUND" : "CONFLICT", message, { reason });
    this.name = "LeadBotError";
  }
}

const HISTORY_LIMIT = 20;
/** Each chat message triggers a model call, so each person is limited per minute. */
export const CHAT_MESSAGES_PER_MINUTE = 10;
const titleSchema = z.string().trim().min(1, "Give the conversation a title").max(200, "Keep the title under 200 characters");
const contentSchema = z.string().trim().min(1, "Type a message").max(4000, "Keep messages under 4,000 characters");

async function isKnownRef(tx: Tx, threadId: string, clientRef: string): Promise<boolean> {
  const [m] = await tx.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.clientRef, clientRef)));
  return !!m;
}

async function loadThread(tx: Tx, threadId: string): Promise<ChatThreadRow> {
  const [t] = isUuid(threadId) ? await tx.select().from(chatThreads).where(eq(chatThreads.id, threadId)) : [];
  if (!t) throw new LeadBotError("Conversation not found", "THREAD_NOT_FOUND");
  return t;
}

export async function createThread(input: { actorUserId: string; orgId: string; title: string }): Promise<{ threadId: string }> {
  const title = titleSchema.safeParse(input.title);
  if (!title.success) throw new AppError("VALIDATION", title.error.issues[0]?.message ?? "Invalid title");
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "chat.thread.create");
    const [row] = await tx.insert(chatThreads).values({ tenantId: input.orgId, title: title.data, createdBy: input.actorUserId }).returning({ id: chatThreads.id });
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "chat.thread.create", target: `chat_thread:${row!.id}`, tier: 1, outcome: "success" });
    return { threadId: row!.id };
  });
}

export async function listThreads(input: { actorUserId: string; orgId: string }): Promise<ChatThreadRow[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "chat.thread.list");
    return tx.select().from(chatThreads).orderBy(desc(chatThreads.updatedAt)).limit(100);
  });
}

export async function getThread(input: { actorUserId: string; orgId: string; threadId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "chat.thread.get");
    const thread = await loadThread(tx, input.threadId);
    const rows = await tx
      .select({ message: chatMessages, authorName: users.name })
      .from(chatMessages)
      .leftJoin(users, eq(users.id, chatMessages.authorUserId))
      .where(eq(chatMessages.threadId, thread.id))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
    const messages = rows.map((r) => ({ ...r.message, authorName: r.message.authorType === "user" ? (r.authorName ?? "Former member") : "Lead bot" }));
    const delegations = await tx
      .select({ messageId: chatDelegations.messageId, taskId: chatDelegations.taskId, agentKind: chatDelegations.agentKind, state: tasks.state, intent: tasks.intent, title: tasks.title, plan: tasks.plan, error: tasks.error })
      .from(chatDelegations)
      .innerJoin(tasks, and(eq(tasks.tenantId, chatDelegations.tenantId), eq(tasks.id, chatDelegations.taskId)))
      .where(eq(chatDelegations.threadId, thread.id));
    return { thread, messages, delegations };
  });
}

export interface SendResult {
  messageId: string;
  replyId: string | null;
  taskIds: string[];
  duplicate: boolean;
  mock: boolean;
}

/**
 * The owner (or any staff member) sends a message; the lead bot replies and
 * may delegate. Delegation only creates ordinary tasks for preset agents, so
 * every action still goes through policy and approvals in the engine. The
 * lead bot has no tools of its own besides `delegate`.
 */
export async function sendMessage(input: { actorUserId: string; orgId: string; threadId: string; content: string; clientRef?: string }): Promise<SendResult> {
  const content = contentSchema.safeParse(input.content);
  if (!content.success) throw new AppError("VALIDATION", content.error.issues[0]?.message ?? "Invalid message");
  const clientRef = input.clientRef?.slice(0, 100);

  // 1. Store the person's message (once per clientRef).
  const stored = await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "chat.message.send");
    const thread = await loadThread(tx, input.threadId);
    const [recent] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(chatMessages)
      .where(and(eq(chatMessages.authorUserId, input.actorUserId), gt(chatMessages.createdAt, sql`now() - interval '1 minute'`)));
    if ((recent?.n ?? 0) >= CHAT_MESSAGES_PER_MINUTE && !(clientRef && (await isKnownRef(tx, thread.id, clientRef)))) {
      // Recorded in its own transaction: this one rolls back when we throw.
      await auditDenied(input.orgId, input.actorUserId, "chat.message.send", { reason: "rate_limited", threadId: thread.id });
      throw new AppError("RATE_LIMITED", `You've sent ${CHAT_MESSAGES_PER_MINUTE} messages in the last minute. Wait a moment and try again.`);
    }
    const paused = await agentsPaused(tx, input.orgId);
    const [row] = await tx
      .insert(chatMessages)
      .values({ tenantId: input.orgId, threadId: thread.id, authorType: "user", authorUserId: input.actorUserId, content: content.data, clientRef: clientRef ?? null })
      .onConflictDoNothing()
      .returning({ id: chatMessages.id });
    if (!row) {
      const [prior] = await tx.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.threadId, thread.id), eq(chatMessages.clientRef, clientRef!)));
      return { id: prior!.id, duplicate: true, paused };
    }
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "chat.message.send", target: `chat_message:${row.id}`, tier: 1, outcome: "success", metadata: { threadId: thread.id } });
    const history = await tx.select().from(chatMessages).where(eq(chatMessages.threadId, thread.id)).orderBy(desc(chatMessages.createdAt), desc(chatMessages.id)).limit(HISTORY_LIMIT);
    return { id: row.id, duplicate: false, history: history.reverse(), paused };
  });
  const { router } = getEngine();
  if (stored.duplicate) return { messageId: stored.id, replyId: null, taskIds: [], duplicate: true, mock: router.isMock };

  // Kill switch: no model call, no hand-offs. Say so plainly.
  if (stored.paused) {
    const replyId = await inOrg(input.orgId, async (tx) => {
      const [r] = await tx
        .insert(chatMessages)
        .values({ tenantId: input.orgId, threadId: input.threadId, authorType: "lead", content: "Agents are paused for this organization, so nothing was handed off. An owner can resume them in Settings." })
        .returning({ id: chatMessages.id });
      await recordAudit(tx, { tenantId: input.orgId, actorType: "agent", actorId: "lead", action: "chat.lead.reply", target: `chat_message:${r!.id}`, tier: 0, outcome: "denied", metadata: { reason: "agents_paused" } });
      return r!.id;
    });
    return { messageId: stored.id, replyId, taskIds: [], duplicate: false, mock: router.isMock };
  }

  // 2. Ask the lead bot (outside any transaction). Earlier turns go in as data.
  const earlier = stored.history!.filter((m) => m.id !== stored.id);
  let res;
  try {
    res = await router.complete({
      purpose: "lead.plan",
      tenantId: input.orgId,
      system: `${SAFETY_PREAMBLE}\n\n${LEAD_BOT_SYSTEM}`,
      messages: [
        {
          role: "user",
          content: [earlier.length ? externalData("chat_history", earlier.map((m) => `${m.authorType}: ${m.content}`).join("\n")) : "", `Request from the business user:\n${content.data}`].filter(Boolean).join("\n\n"),
        },
      ],
      tools: [DELEGATE_TOOL],
      maxTokens: 1024,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ tenantId: input.orgId, threadId: input.threadId, err: message }, "lead bot model call failed");
    const replyId = await inOrg(input.orgId, async (tx) => {
      const [r] = await tx.insert(chatMessages).values({ tenantId: input.orgId, threadId: input.threadId, authorType: "lead", content: `I couldn't reach the AI model, so nothing was handed off. (${message.slice(0, 300)})` }).returning({ id: chatMessages.id });
      await recordAudit(tx, { tenantId: input.orgId, actorType: "agent", actorId: "lead", action: "chat.lead.reply", target: `chat_message:${r!.id}`, tier: 0, outcome: "error", metadata: { reason: "MODEL_UNAVAILABLE" } });
      return r!.id;
    });
    return { messageId: stored.id, replyId, taskIds: [], duplicate: false, mock: router.isMock };
  }

  // 3. Validate delegations and create tasks, all in one transaction with the reply.
  return inOrg(input.orgId, async (tx) => {
    // Re-check: the person's role may have changed while the model was thinking.
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "chat.message.send");
    const accepted: { agent: DelegableKind; request: string }[] = [];
    const refused: { name: string; reason: string }[] = [];
    for (const call of res.toolCalls) {
      const parsed = call.name === "delegate" ? delegateArgs.safeParse(call.input) : null;
      if (!parsed?.success) refused.push({ name: call.name, reason: call.name === "delegate" ? "invalid_arguments" : "unknown_tool" });
      else if (accepted.some((a) => a.agent === parsed.data.agent)) refused.push({ name: parsed.data.agent, reason: "one_task_per_agent_per_turn" });
      else if (accepted.length >= MAX_DELEGATIONS_PER_TURN) refused.push({ name: parsed.data.agent, reason: "fan_out_limit" });
      else if (!(await loadAgent(tx, { kind: parsed.data.agent }))) refused.push({ name: parsed.data.agent, reason: "no_active_agent" });
      else accepted.push(parsed.data);
    }
    const note = refused.length ? `\n\n(${refused.length} hand-off${refused.length > 1 ? "s" : ""} refused: ${refused.map((r) => `${r.name}: ${r.reason.replaceAll("_", " ")}`).join("; ")})` : "";
    const text = (res.text.trim() || (accepted.length ? `Handed to ${accepted.map((a) => a.agent).join(", ")}.` : "No hand-offs.")).slice(0, 7000) + note;
    const [reply] = await tx
      .insert(chatMessages)
      .values({ tenantId: input.orgId, threadId: input.threadId, authorType: "lead", content: text, provider: res.provider, model: res.model, mock: router.isMock })
      .returning({ id: chatMessages.id });
    await recordAudit(tx, { tenantId: input.orgId, actorType: "agent", actorId: "lead", action: "chat.lead.reply", target: `chat_message:${reply!.id}`, tier: 0, outcome: "success", metadata: { provider: res.provider, mock: router.isMock, delegations: accepted.length } });
    for (const r of refused) {
      await recordAudit(tx, { tenantId: input.orgId, actorType: "agent", actorId: "lead", action: "chat.delegate", target: `chat_message:${reply!.id}`, tier: 0, outcome: "denied", metadata: r });
    }
    const taskIds: string[] = [];
    for (const a of accepted) {
      // chainId = the lead bot message that started the chain. The original
      // chat text travels as external data so its addresses/URLs are tainted.
      const delegation = { chainId: reply!.id, depth: MAX_DELEGATION_DEPTH, threadId: input.threadId };
      const { taskId } = await insertTask(tx, {
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        intent: a.request,
        title: `${a.agent[0]!.toUpperCase()}${a.agent.slice(1)} (from chat): ${a.request}`,
        input: { agentKind: a.agent, delegation, chatMessage: content.data },
        auditMetadata: { chainId: delegation.chainId, via: "lead" },
      });
      await tx.insert(chatDelegations).values({ tenantId: input.orgId, threadId: input.threadId, messageId: reply!.id, taskId, agentKind: a.agent });
      await recordAudit(tx, { tenantId: input.orgId, actorType: "agent", actorId: "lead", action: "chat.delegate", target: `task:${taskId}`, tier: 1, outcome: "success", metadata: { agent: a.agent, chainId: delegation.chainId } });
      taskIds.push(taskId);
    }
    await tx.update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, input.threadId));
    return { messageId: stored.id, replyId: reply!.id, taskIds, duplicate: false, mock: router.isMock };
  });
}

