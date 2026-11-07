import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { agents, approvalRequests, conversations, invoices, isUuid, memoryRecords, messages, organizations, tasks, workflowExecutions, withTenant, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { listAuditEvents } from "../audit-log/service";
import { AppError } from "../errors";
import { scrubPii } from "../logger";
import { ANY_ROLE, inOrg, MANAGERS, requireRole, STAFF } from "../org/access";
import { getPack, type IndustryPack } from "../industries/packs";
import { actionDigest } from "../engine/digest";
import { loadAgent } from "../engine/agents";
import { enqueueTaskRun } from "../engine/queue";
import { getEngine } from "../engine/runtime";
import { createTask, transition } from "../engine/tasks";
import { delegationOf, type PlanStep } from "../engine/executor";
import { forgetMemory, rememberFact } from "../memory/service";
import { createRoutine } from "../routines/service";
import { messageIdFor } from "../integrations/mail";
import { requestSendDraft } from "../inbox/service";
import { ingestLead } from "../speed/service";
import { gateOutboundMail, outboundRecipients, replyRecipients, replySubject, sendContentHash, snapshotFromDraft } from "../tools/inbox";
import { seasonalHits, type SignalHit } from "../signals/sources";
import { approvalCard, approvalExpiryMs, type ApprovalCardView } from "./cards";

const RULE = "kimi:rule:";
const PAUSE = "kimi:pause:";
const DRAFT = "kimi:draft:";
const GOAL = "kimi:goal:";
const ARTIFACT = "kimi:artifact:";
const NOTIFY = "kimi:notify";

function parse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function putJson(tx: Tx, tenantId: string, userId: string, scope: string, value: unknown) {
  const content = JSON.stringify(value).slice(0, 2000);
  await tx.insert(memoryRecords).values({
    tenantId,
    layer: "org",
    scopeRef: scope,
    content,
    trust: "user",
    createdByUser: userId,
  });
}

export interface SavedRule {
  id: string;
  text: string;
  tier: number;
  savedAt: string;
}

/**
 * A suggestion the owner must explicitly save. The tier comes from the tool
 * registry, not from the caller. Refused for money, irreversible, and tier >= 2.
 */
export async function saveSuggestedRule(input: { actorUserId: string; orgId: string; text: string; toolName: string }): Promise<SavedRule> {
  const text = input.text.trim().slice(0, 300);
  if (!text) throw new AppError("VALIDATION", "Write the rule in plain words");
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "kimi.rule.save");
    const tool = getEngine().tools.get(input.toolName);
    if (!tool) throw new AppError("FORBIDDEN", "That action isn't available, so it can't become a rule.");
    const card = approvalCard({ summary: text, tier: tool.tier, toolName: tool.name });
    if (card.alwaysAllowBlocked || tool.tier >= 2) {
      throw new AppError("FORBIDDEN", card.alwaysAllowBlocked ?? "That kind of action always needs a person.");
    }
    const id = crypto.randomUUID();
    const saved: SavedRule = { id, text, tier: tool.tier, savedAt: new Date().toISOString() };
    await putJson(tx, input.orgId, input.actorUserId, `${RULE}${id}`, saved);
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "kimi.rule.save", target: `rule:${id}`, tier: 1, outcome: "success", metadata: { tier: tool.tier, tool: tool.name } });
    return saved;
  });
}

export async function listRules(input: { actorUserId: string; orgId: string }): Promise<SavedRule[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "kimi.rule.list");
    const rows = await tx.select().from(memoryRecords).where(sql`${memoryRecords.scopeRef} LIKE 'kimi:rule:%'`).orderBy(desc(memoryRecords.createdAt)).limit(50);
    return rows.map((r) => parse<SavedRule>(r.content)).filter((r): r is SavedRule => !!r);
  });
}

export interface FeedStep {
  stage: "trigger" | "read" | "decision" | "action" | "result";
  action: string;
  at: string;
}

export interface FeedGroup {
  job: string;
  steps: FeedStep[];
}

function stageOf(action: string): FeedStep["stage"] {
  if (action.startsWith("approval.")) return "decision";
  if (action.includes("lookup") || action.startsWith("read.") || action.endsWith(".scan") || action.includes("sync")) return "read";
  if (action.startsWith("task.create") || action.startsWith("routine.") || action.startsWith("speed.lead")) return "trigger";
  if (action.includes("COMPLETED") || action.includes("FAILED") || action.startsWith("task.transition")) return "result";
  return "action";
}

/** Redacted lineage grouped by job. Secrets in metadata are not copied onto the feed. */
export async function activityFeed(input: { actorUserId: string; orgId: string }): Promise<FeedGroup[]> {
  const rows = await listAuditEvents({ actorUserId: input.actorUserId, orgId: input.orgId, limit: 200 });
  const groups = new Map<string, FeedStep[]>();
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as { taskId?: unknown };
    const job = feedGroupKey(meta.taskId ?? row.target ?? "workspace");
    const step: FeedStep = { stage: stageOf(row.action), action: String(scrubPii(row.action)), at: row.at.toISOString() };
    const list = groups.get(job) ?? [];
    list.push(step);
    groups.set(job, list);
  }
  return [...groups.entries()].map(([job, steps]) => ({ job, steps: steps.reverse() }));
}

export async function pauseTask(input: { actorUserId: string; orgId: string; taskId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "kimi.pause");
    await putJson(tx, input.orgId, input.actorUserId, `${PAUSE}${input.taskId}`, { at: new Date().toISOString() });
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "kimi.pause", target: `task:${input.taskId}`, tier: 1, outcome: "success" });
    return { paused: true };
  });
}

export async function taskHeld(tenantId: string, taskId: string): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.select({ id: memoryRecords.id }).from(memoryRecords).where(eq(memoryRecords.scopeRef, `${PAUSE}${taskId}`)).limit(1);
    return !!row;
  });
}

export async function takeOverDraft(input: { actorUserId: string; orgId: string; taskId: string; text: string }) {
  const text = input.text.trim().slice(0, 1500);
  if (!text) throw new AppError("VALIDATION", "Write the draft you want to take over");
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "kimi.takeover");
    await putJson(tx, input.orgId, input.actorUserId, `${DRAFT}${input.taskId}`, { text, at: new Date().toISOString() });
    await putJson(tx, input.orgId, input.actorUserId, `${PAUSE}${input.taskId}`, { at: new Date().toISOString(), reason: "takeover" });
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "kimi.takeover", target: `task:${input.taskId}`, tier: 1, outcome: "success" });
    return { text };
  });
}

/** Hands the draft back. The mailbox draft and a new approval match the owner's text. Nothing is sent here. */
export async function handBack(input: { actorUserId: string; orgId: string; taskId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "kimi.handback");
    const [draftRow] = await tx.select().from(memoryRecords).where(eq(memoryRecords.scopeRef, `${DRAFT}${input.taskId}`)).orderBy(desc(memoryRecords.createdAt)).limit(1);
    const draft = parse<{ text: string }>(draftRow?.content ?? "")?.text?.trim() ?? "";
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId));
    if (!task) throw new AppError("NOT_FOUND", "Task not found");
    const inputJson = (task.input ?? {}) as Record<string, unknown>;
    const nextInput = draft ? { ...inputJson, ownerDraft: draft } : inputJson;
    const nextIntent = draft ? bindIntent(task.intent, draft) : task.intent;
    const plan = draft && task.assignedAgentId ? await rebindPlan(tx, input.orgId, task, draft) : null;
    if (plan && task.state === "ASSIGNED") {
      await tx.update(tasks).set({ input: nextInput, intent: nextIntent, updatedAt: new Date() }).where(eq(tasks.id, task.id));
      const [fresh] = await tx.select().from(tasks).where(eq(tasks.id, task.id));
      await transition(tx, fresh!, "WAITING_FOR_APPROVAL", { plan });
    } else {
      await tx.update(tasks).set({ input: nextInput, intent: nextIntent, ...(plan ? { plan } : {}), updatedAt: new Date() }).where(eq(tasks.id, task.id));
    }
    await tx.delete(memoryRecords).where(eq(memoryRecords.scopeRef, `${PAUSE}${input.taskId}`));
    await enqueueTaskRun(tx, { tenantId: input.orgId, taskId: input.taskId });
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "kimi.handback", target: `task:${input.taskId}`, tier: 1, outcome: "success", metadata: { sent: false, bound: !!draft } });
    return { handedBack: true, sent: false as const, bound: !!draft };
  });
}

function bindIntent(intent: string, draft: string): string {
  const note = `Owner draft (use this text; do not send it until a person approves):\n${draft}`;
  if (intent.includes(draft)) return intent.slice(0, 4000);
  return `${intent}\n\n${note}`.slice(0, 4000);
}

const DRAFT_FIELDS = new Set(["body", "content", "text"]);

async function rebindPlan(tx: Tx, orgId: string, task: { id: string; tenantId: string; assignedAgentId: string | null; requestedBy: string; input: unknown; plan: unknown }, draft: string) {
  const plan = task.plan as { steps?: PlanStep[]; direct?: unknown; note?: string; model?: unknown } | null;
  if (!plan?.steps?.length || !task.assignedAgentId) return null;
  const chainId = delegationOf((task.input ?? undefined) as Record<string, unknown> | undefined)?.chainId;
  const steps: PlanStep[] = [];
  for (const step of plan.steps) {
    if (!step.args || typeof step.args !== "object" || Array.isArray(step.args)) {
      steps.push(step);
      continue;
    }
    const args = { ...(step.args as Record<string, unknown>) };
    let changed = false;
    if (step.tool === "inbox.send_draft" && typeof args.conversationId === "string") {
      const canonical = await writeAuthoritativeDraft(tx, orgId, args.conversationId, draft, {
        draftExternalId: typeof args.draftExternalId === "string" ? args.draftExternalId : undefined,
        draftMessageId: typeof args.draftMessageId === "string" ? args.draftMessageId : undefined,
      });
      args.conversationId = canonical.conversationId;
      args.to = canonical.to;
      args.cc = canonical.cc;
      args.bcc = canonical.bcc;
      args.replyTo = canonical.replyTo;
      args.subject = canonical.subject;
      args.body = canonical.body;
      args.attachments = canonical.attachments;
      args.draftExternalId = canonical.draftExternalId;
      args.draftMessageId = canonical.draftMessageId;
      args.contentHash = sendContentHash(canonical);
      const gate = await gateOutboundMail(tx, { tenantId: orgId, actorType: "agent", actorId: task.assignedAgentId, target: `task:${task.id}`, recipients: outboundRecipients(canonical) });
      if (!gate.allowed) throw new AppError("CONFLICT", gate.message);
      changed = true;
    } else {
      for (const key of Object.keys(args)) {
        if (DRAFT_FIELDS.has(key) && typeof args[key] === "string" && args[key] !== draft) {
          args[key] = draft;
          changed = true;
        }
      }
    }
    if (!changed) {
      steps.push(step);
      continue;
    }
    const digest = actionDigest({ tenantId: task.tenantId, taskId: task.id, agentId: task.assignedAgentId, step: step.index, tool: step.tool, args, ...(chainId ? { chainId } : {}) });
    const tool = getEngine().tools.get(step.tool);
    const summary = (tool ? tool.summarize(args) : `Use the owner's draft: ${draft}`).slice(0, 500);
    const approvalId = step.approvalId ? await reraiseApproval(tx, step.approvalId, { digest, summary, payload: { tool: step.tool, args, step: step.index, ownerDraft: true }, requestedBy: task.requestedBy }) : step.approvalId;
    steps.push({ ...step, args, digest, summary, ...(approvalId ? { approvalId } : {}) });
  }
  return { ...plan, steps };
}

/** Writes the owner's text onto this follow-up's own mailbox draft. A deleted draft gets a new id. */
async function writeAuthoritativeDraft(tx: Tx, orgId: string, conversationId: string, body: string, pinned?: { draftExternalId?: string; draftMessageId?: string }) {
  const [conv] = isUuid(conversationId) ? await tx.select().from(conversations).where(eq(conversations.id, conversationId)) : [];
  if (!conv) throw new AppError("NOT_FOUND", "Conversation not found");
  const [lastInbound] = await tx.select().from(messages).where(and(eq(messages.conversationId, conv.id), eq(messages.direction, "inbound"))).orderBy(desc(messages.sentAt)).limit(1);
  const to = replyRecipients(lastInbound);
  if (!to.length) throw new AppError("CONFLICT", "This conversation has no sender to reply to.");
  const subject = replySubject(conv.subject);
  const box = await getEngine().mailbox?.(orgId);
  if (!box) throw new AppError("CONFLICT", "No mailbox is connected, so the draft can't be updated.");
  const previousId = pinned?.draftExternalId ?? conv.draftExternalId ?? undefined;
  let draftExternalId = previousId;
  let draftMessageId = pinned?.draftMessageId ?? conv.draftMessageId ?? undefined;
  const base = { threadId: conv.externalThreadId, to, subject, body, inReplyTo: lastInbound?.rfc822MessageId ?? undefined };
  let updated = false;
  if (draftExternalId && draftMessageId) {
    try {
      await box.provider.updateDraft(draftExternalId, { ...base, messageId: draftMessageId });
      updated = true;
    } catch {
      updated = false;
    }
  }
  if (!updated) {
    draftMessageId = messageIdFor(`handback:${randomUUID()}`);
    const created = await box.provider.createDraft({ ...base, messageId: draftMessageId });
    draftExternalId = created.draftId;
  }
  const stillLatest = !conv.draftExternalId || conv.draftExternalId === previousId;
  if (stillLatest) {
    await tx.update(conversations).set({ draftBody: body, draftExternalId, draftMessageId, updatedAt: new Date() }).where(eq(conversations.id, conv.id));
  }
  const written = draftMessageId ? await box.provider.findDraft(draftMessageId) : undefined;
  const snap = written ? snapshotFromDraft(conv.id, draftMessageId!, written) : null;
  if (!snap || snap.draftExternalId !== draftExternalId) throw new AppError("CONFLICT", "The mailbox draft is not there.");
  return snap;
}

async function reraiseApproval(tx: Tx, approvalId: string, next: { digest: string; summary: string; payload: Record<string, unknown>; requestedBy: string }) {
  const [old] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, approvalId));
  const open = old && !old.consumedAt && (old.status === "pending" || old.status === "awaiting_confirmation" || old.status === "approved");
  if (!old || !open) return approvalId;
  await tx.update(approvalRequests).set({ status: "expired" }).where(eq(approvalRequests.id, old.id));
  const minutes = Number(process.env.WOS_BACKGROUND_APPROVAL_MINUTES ?? 45);
  const [created] = await tx.insert(approvalRequests).values({
    tenantId: old.tenantId,
    taskId: old.taskId,
    agentId: old.agentId,
    toolName: old.toolName,
    tier: old.tier,
    actionDigest: next.digest,
    payload: next.payload,
    summary: next.summary,
    status: "pending",
    expiresAt: new Date(Date.now() + approvalExpiryMs(next.requestedBy, minutes)),
  }).returning({ id: approvalRequests.id });
  return created!.id;
}

export async function watchTask(input: { actorUserId: string; orgId: string; taskId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "kimi.watch");
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId));
    if (!task) throw new AppError("NOT_FOUND", "Task not found");
    const steps = await tx.select().from(workflowExecutions).where(eq(workflowExecutions.taskId, task.id)).orderBy(workflowExecutions.startedAt);
    const [paused] = await tx.select({ id: memoryRecords.id }).from(memoryRecords).where(eq(memoryRecords.scopeRef, `${PAUSE}${task.id}`)).limit(1);
    const [draft] = await tx.select().from(memoryRecords).where(eq(memoryRecords.scopeRef, `${DRAFT}${task.id}`)).limit(1);
    return {
      state: task.state,
      paused: !!paused,
      draft: draft ? parse<{ text: string }>(draft.content)?.text ?? "" : "",
      steps: steps.map((s) => ({ step: s.step, status: s.status, at: s.startedAt.toISOString() })),
    };
  });
}

export interface MemoryFact {
  id: string;
  text: string;
  by: string;
  at: string;
  trust: string;
}

export async function memoryPanel(input: { actorUserId: string; orgId: string }): Promise<MemoryFact[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "kimi.memory");
    const rows = await tx
      .select()
      .from(memoryRecords)
      .where(and(eq(memoryRecords.layer, "org"), sql`${memoryRecords.scopeRef} = 'org'`))
      .orderBy(desc(memoryRecords.createdAt))
      .limit(100);
    return rows.map((r) => ({ id: r.id, text: r.content, by: r.createdByUser ?? "Scout", at: r.createdAt.toISOString(), trust: r.trust }));
  });
}

/** "forget commercial work" → the phrase to remove. Empty when it isn't a forget command. */
export function parseForget(text: string): string | null {
  const m = /^\s*forget\s+(.+)$/i.exec(text.trim());
  return m?.[1]?.trim() || null;
}

export interface ChatRoutine {
  id: string;
  plain: string;
  daysOfWeek: number[];
  hour: number;
  maxTier: 0 | 1;
  sends: false;
  /** A real routines row, scheduled. It does not send. */
  scheduled: true;
}

/**
 * Stable activity-feed group label. The raw key is scrubbed and then hashed
 * so an email address or a provider key cannot appear in the group name.
 */
export function feedGroupKey(raw: unknown): string {
  const scrubbed = String(scrubPii(raw == null ? "workspace" : String(raw)) ?? "workspace");
  const hash = createHash("sha256").update(scrubbed).digest("hex").slice(0, 12);
  return `job:${hash}`;
}

const DAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

/** Confirms a chat routine in plain words. Sending and money stay out of the autonomous tier. */
export function parseChatRoutine(text: string): { plain: string; daysOfWeek: number[]; hour: number; maxTier: 0 | 1 } | { refused: string } {
  if (/\b(pay|charge|refund|delete|wire)\b/i.test(text)) return { refused: "I won't schedule anything that spends money or can't be undone." };
  const day = Object.keys(DAYS).find((name) => new RegExp(`\\b${name}\\b`, "i").test(text));
  if (!/\bevery\b/i.test(text) || !day) return { refused: "Say which day, for example: every Friday, list next week's customers." };
  const sends = /\b(text|sms|email|send)\b/i.test(text);
  const plain = sends
    ? `Every ${day}, I'll prepare that list. Sending still needs your OK.`
    : `Every ${day} at 9:00, I'll do this read-only step: ${text.trim().slice(0, 160)}`;
  return { plain, daysOfWeek: [DAYS[day]!], hour: 9, maxTier: 1 };
}

/**
 * A chat sentence becomes a real routines row. The applied schema only allows
 * the morning briefing, which is read-only: maxTier stays 0 and it does not send.
 */
export async function saveChatRoutine(input: { actorUserId: string; orgId: string; text: string; timezone?: string }): Promise<ChatRoutine> {
  const parsed = parseChatRoutine(input.text);
  if ("refused" in parsed) throw new AppError("FORBIDDEN", parsed.refused);
  const timezone = input.timezone ?? (await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "kimi.routine");
    const [org] = await tx.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, input.orgId));
    return org?.timezone || "America/New_York";
  }));
  const created = await createRoutine({
    actorUserId: input.actorUserId,
    orgId: input.orgId,
    kind: "morning_briefing",
    name: parsed.plain.slice(0, 120),
    hour: parsed.hour,
    minute: 0,
    daysOfWeek: parsed.daysOfWeek,
    timezone,
  });
  return { id: created.id, plain: parsed.plain, daysOfWeek: parsed.daysOfWeek, hour: parsed.hour, maxTier: 0, sends: false, scheduled: true };
}

const PRACTICE_FACT = "Example prices are not quotes.";
const PRACTICE_DISMISS = "kimi:practice-dismissed";

export interface ChatCommandResult {
  reply: string;
  chip: { kind: "remembered"; memoryId: string; text: string } | { kind: "routine"; routineId: string; text: string } | null;
}

/** Remember, forget, and "every Friday" stay in the product. They do not call the model and they do not send. */
export async function applyChatCommand(input: { actorUserId: string; orgId: string; text: string }): Promise<ChatCommandResult | null> {
  const text = input.text.trim();
  const remember = /^\s*remember\s+(.+)$/i.exec(text);
  if (remember) {
    const row = await rememberFact({ actorUserId: input.actorUserId, orgId: input.orgId, content: remember[1]! });
    return { reply: `[[kimi:remembered:${row.id}]]Remembered: ${row.content}`, chip: { kind: "remembered", memoryId: row.id, text: row.content } };
  }
  const phrase = parseForget(text);
  if (phrase) {
    try {
      const forgotten = await forgetByPhrase({ actorUserId: input.actorUserId, orgId: input.orgId, phrase });
      return { reply: `Forgot “${forgotten.text}”.`, chip: null };
    } catch (err) {
      if (err instanceof AppError && (err.code === "NOT_FOUND" || err.code === "FORBIDDEN")) return { reply: err.message, chip: null };
      throw err;
    }
  }
  if (/\bevery\b/i.test(text) && /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|pay|charge|refund|delete|wire)\b/i.test(text)) {
    const parsed = parseChatRoutine(text);
    if ("refused" in parsed) return { reply: parsed.refused, chip: null };
    const saved = await saveChatRoutine({ actorUserId: input.actorUserId, orgId: input.orgId, text });
    return { reply: `${saved.plain} This is on the schedule. It does not send.`, chip: { kind: "routine", routineId: saved.id, text: saved.plain } };
  }
  return null;
}

export async function forgetByPhrase(input: { actorUserId: string; orgId: string; phrase: string }) {
  const phrase = input.phrase.trim().toLowerCase();
  if (!phrase) throw new AppError("VALIDATION", "Say what to forget");
  const rows = await memoryPanel({ actorUserId: input.actorUserId, orgId: input.orgId });
  const hit = rows.find((r) => r.text.toLowerCase().includes(phrase));
  if (!hit) throw new AppError("NOT_FOUND", `I don't have anything about “${input.phrase.trim()}”.`);
  await forgetMemory({ actorUserId: input.actorUserId, orgId: input.orgId, memoryId: hit.id });
  return { id: hit.id, text: hit.text };
}

export interface OpportunityCard {
  id: string;
  lane: "Inbox" | "Schedule" | "Follow-ups" | "Reviews" | "Money";
  title: string;
  draft: string;
  requiresApproval: true;
  demo: boolean;
}

/** Read-only. Every card is a draft. Nothing is sent. */
export function opportunityCards(pack: IndustryPack, now = new Date()): OpportunityCard[] {
  const seasonal = seasonalHits(pack, now).slice(0, 1);
  const cards: OpportunityCard[] = [
    {
      id: "reviews",
      lane: "Reviews",
      title: "Unanswered reviews",
      draft: `MOCK draft: thank a customer for a recent visit to ${pack.label}. Nothing is posted until you approve.`,
      requiresApproval: true,
      demo: true,
    },
    {
      id: "gap",
      lane: "Schedule",
      title: "Open time tomorrow afternoon",
      draft: `MOCK draft: offer one open afternoon slot. Sending it still needs your OK.`,
      requiresApproval: true,
      demo: true,
    },
  ];
  for (const hit of seasonal) {
    cards.push({ id: hit.title, lane: "Follow-ups", title: hit.title, draft: `${hit.why} This is a draft, not a message.`, requiresApproval: true, demo: !!hit.demo });
  }
  if (pack.signals.includes("weather")) {
    cards.push({
      id: "weather",
      lane: "Follow-ups",
      title: "Weather over the service area",
      draft: "A forecast is not damage. Any customer message still waits for approval.",
      requiresApproval: true,
      demo: false,
    });
  }
  return cards;
}

export function opportunityCardsForPack(packId: string, now = new Date()): OpportunityCard[] {
  return opportunityCards(getPack(packId), now);
}

export async function opportunitiesFor(input: { actorUserId: string; orgId: string; packId: string }): Promise<OpportunityCard[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "kimi.opportunities");
    return opportunityCardsForPack(input.packId);
  });
}

export type Urgency = "now" | "brief";

export function classifyUrgency(input: { money?: boolean; sameDay?: boolean; customerWaiting?: boolean }): Urgency {
  if (input.money || input.sameDay || input.customerWaiting) return "now";
  return "brief";
}

export function withinQuietHours(hour: number, start = 21, end = 8): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function batchNotifications<T extends { id: string; urgency: Urgency }>(items: T[], opts: { hour: number; alreadyToday: number; cap?: number; quietStart?: number; quietEnd?: number }): { now: T[]; brief: T[] } {
  const cap = opts.cap ?? 5;
  const quiet = withinQuietHours(opts.hour, opts.quietStart ?? 21, opts.quietEnd ?? 8);
  const seen = new Set<string>();
  const now: T[] = [];
  const brief: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (item.urgency === "now" && !quiet && opts.alreadyToday + now.length < cap) now.push(item);
    else brief.push(item);
  }
  return { now, brief };
}

export interface FirstRunScript {
  mock: true;
  lead: { text: string; draft: string; needsApproval: true };
  business: { name: string; lines: string[] };
  brief: { lines: { text: string; action: string }[] };
  textDemo: { label: "DEMO"; reply: string };
}

export async function firstRunFor(input: { actorUserId: string; orgId: string; businessName: string; packId: string }): Promise<FirstRunScript & { practiceMemoryId: string | null }> {
  const script = firstRunScript({ businessName: input.businessName, packId: input.packId });
  const role = await inOrg(input.orgId, (tx) => requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "kimi.firstRun"));
  if (role === "viewer") return { ...script, practiceMemoryId: null };
  await ingestLead({
    actorUserId: input.actorUserId,
    orgId: input.orgId,
    source: "web_form",
    externalKey: "kimi-practice-lead",
    name: "MOCK neighbor",
    email: "mock-lead@example.test",
    customBody: script.lead.draft,
  });
  const practiceMemoryId = await ensurePracticeFact(input.actorUserId, input.orgId);
  return { ...script, practiceMemoryId };
}

async function ensurePracticeFact(actorUserId: string, orgId: string): Promise<string | null> {
  return inOrg(orgId, async (tx) => {
    const [dismissed] = await tx.select({ id: memoryRecords.id }).from(memoryRecords).where(eq(memoryRecords.scopeRef, PRACTICE_DISMISS)).limit(1);
    if (dismissed) return null;
    const [existing] = await tx
      .select({ id: memoryRecords.id })
      .from(memoryRecords)
      .where(and(eq(memoryRecords.scopeRef, "org"), eq(memoryRecords.content, PRACTICE_FACT)))
      .limit(1);
    return existing?.id ?? null;
  }).then(async (id) => {
    if (id) return id;
    const dismissed = await inOrg(orgId, async (tx) => {
      const [row] = await tx.select({ id: memoryRecords.id }).from(memoryRecords).where(eq(memoryRecords.scopeRef, PRACTICE_DISMISS)).limit(1);
      return !!row;
    });
    if (dismissed) return null;
    const row = await rememberFact({ actorUserId, orgId, content: PRACTICE_FACT });
    return row.id;
  });
}

/** Undo on the first-run card. Removes the fact and does not put it back on the next visit. */
export async function undoPracticeMemory(input: { actorUserId: string; orgId: string; memoryId?: string }) {
  if (input.memoryId) {
    try {
      await forgetMemory({ actorUserId: input.actorUserId, orgId: input.orgId, memoryId: input.memoryId });
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== "NOT_FOUND") throw err;
    }
  }
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "kimi.practice.undo");
    const [already] = await tx.select({ id: memoryRecords.id }).from(memoryRecords).where(eq(memoryRecords.scopeRef, PRACTICE_DISMISS)).limit(1);
    if (!already) await putJson(tx, input.orgId, input.actorUserId, PRACTICE_DISMISS, { at: new Date().toISOString() });
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "kimi.practice.undo", target: input.memoryId ? `memory:${input.memoryId}` : "memory:practice", tier: 4, outcome: "success", metadata: { sent: false } });
    return { undone: true };
  });
}

export function firstRunScript(input: { businessName: string; packId: string }): FirstRunScript {
  const pack = getPack(input.packId);
  const service = pack.services[0]?.label ?? "a visit";
  return {
    mock: true,
    lead: {
      text: `MOCK lead: ${service} needed soon. How fast can you get here?`,
      draft: `Thanks for reaching ${input.businessName}. We can take a look. This reply is not sent until you approve it.`,
      needsApproval: true,
    },
    business: {
      name: input.businessName,
      lines: pack.services.slice(0, 4).map((s) => `${s.label}${s.priceIsExample && s.priceCents ? ` · example $${(s.priceCents / 100).toFixed(0)}` : ""}`),
    },
    brief: {
      lines: [
        { text: `Today's book for ${pack.label}`, action: "Open the schedule" },
        { text: "One open slot tomorrow afternoon", action: "Draft a fill-in note" },
      ],
    },
    textDemo: {
      label: "DEMO",
      reply: `DEMO reply for ${input.businessName}: tomorrow has one open afternoon. I can't text your phone from here.`,
    },
  };
}

export interface Goal {
  id: string;
  text: string;
  progress: string;
}

export async function saveGoal(input: { actorUserId: string; orgId: string; text: string }): Promise<Goal> {
  const text = input.text.trim().slice(0, 200);
  if (!text) throw new AppError("VALIDATION", "Say the outcome in a sentence");
  if (/\b(pay|charge|refund)\b/i.test(text)) throw new AppError("FORBIDDEN", "A goal can't spend money on its own.");
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "kimi.goal");
    const id = crypto.randomUUID();
    const goal: Goal = { id, text, progress: "Not started. Every step that messages a customer still needs your OK." };
    await putJson(tx, input.orgId, input.actorUserId, `${GOAL}${id}`, goal);
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "kimi.goal.save", target: `goal:${id}`, tier: 1, outcome: "success" });
    return goal;
  });
}

export interface MoneyDigest {
  invoicedCents: number;
  collectedCents: number;
  outstandingCents: number;
  autoPay: false;
  weeklyCapNote: string;
}

export function moneyDigest(input: { invoicedCents: number; collectedCents: number }): MoneyDigest {
  return {
    invoicedCents: input.invoicedCents,
    collectedCents: input.collectedCents,
    outstandingCents: Math.max(0, input.invoicedCents - input.collectedCents),
    autoPay: false,
    weeklyCapNote: "Nothing is paid automatically. A payment still needs your approval.",
  };
}

export function laneOf(action: string): "Inbox" | "Schedule" | "Follow-ups" | "Reviews" | "Money" {
  if (/invoice|payment|billing/i.test(action)) return "Money";
  if (/review/i.test(action)) return "Reviews";
  if (/book|schedul|calendar/i.test(action)) return "Schedule";
  if (/follow|lead|speed/i.test(action)) return "Follow-ups";
  return "Inbox";
}

export interface ChipContext {
  conversationId: string;
  customerEmail: string;
  hasDraft: boolean;
}

/** A follow-up chip exists only when this job already has a real conversation and sender. */
export async function chipsForTask(input: { actorUserId: string; orgId: string; taskId: string }): Promise<{ kind: "follow_up" | "note"; label: string }[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "kimi.chip");
    const ctx = await chipContext(tx, input.taskId);
    if (!ctx) return [];
    const who = redactForDisplay(ctx.customerEmail) || "the customer";
    const chips: { kind: "follow_up" | "note"; label: string }[] = [];
    if (await agentCanRun(tx, "inbox.send_draft")) chips.push({ kind: "follow_up", label: `Draft a follow-up to ${who}` });
    if (await agentCanRun(tx, "memory.propose_fact")) chips.push({ kind: "note", label: `Add a note for ${who}` });
    return chips;
  });
}

/**
 * Starts a real task for a suggested chip. A follow-up uses the job's
 * conversation and the thread's sender. There is no chip without that context.
 * Tier 2+ stops in Approvals. Nothing is sent before that.
 */
export async function startChipAction(input: { actorUserId: string; orgId: string; taskId?: string; kind?: "follow_up" | "note"; label?: string }): Promise<{ taskId: string; tool: string; tier: number }> {
  const kind = input.kind ?? "follow_up";
  const prepared = await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "kimi.chip");
    const ctx = input.taskId ? await chipContext(tx, input.taskId) : null;
    if (!ctx) throw new AppError("CONFLICT", "This job has no conversation to act on.");
    if (kind === "follow_up") {
      const allowed = await agentCanRun(tx, "inbox.send_draft");
      if (!allowed) throw new AppError("CONFLICT", "No approval-gated follow-up is available for that conversation.");
      return { kind, ctx, agentId: allowed.agentId };
    }
    const allowed = await agentCanRun(tx, "memory.propose_fact");
    if (!allowed) throw new AppError("CONFLICT", "No approval-gated note is available for that customer.");
    return { kind, ctx, agentId: allowed.agentId, agentKind: allowed.agentKind };
  });
  if (prepared.kind === "note") {
    const { taskId } = await createTask({
      actorUserId: input.actorUserId,
      orgId: input.orgId,
      title: `Note for ${prepared.ctx.customerEmail}`,
      intent: `Remember a note about ${prepared.ctx.customerEmail}. Nothing is saved until a person approves it.`,
      input: { sourceTaskId: input.taskId, conversationId: prepared.ctx.conversationId },
      direct: { agentKind: prepared.agentKind!, steps: [{ tool: "memory.propose_fact", args: { content: `Note about ${prepared.ctx.customerEmail}`, reason: "Suggested from this job. Nothing is saved until you approve." } }] },
    });
    return { taskId, tool: "memory.propose_fact", tier: 2 };
  }
  const tool = getEngine().tools.get("inbox.create_draft");
  if (!tool) throw new AppError("CONFLICT", "No mailbox draft tool is available.");
  await tool.execute(
    { tenantId: input.orgId, taskId: input.taskId!, agentId: prepared.agentId, idempotencyKey: `follow-up:${randomUUID()}` },
    { conversationId: prepared.ctx.conversationId, body: "Thanks for your note. I'll follow up from here." },
  );
  const { taskId } = await requestSendDraft({ actorUserId: input.actorUserId, orgId: input.orgId, conversationId: prepared.ctx.conversationId });
  return { taskId, tool: "inbox.send_draft", tier: 2 };
}

async function chipContext(tx: Tx, taskId: string): Promise<ChipContext | null> {
  if (!isUuid(taskId)) return null;
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return null;
  const conversationId = conversationIdOf(task);
  if (!conversationId || !isUuid(conversationId)) return null;
  const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!conv) return null;
  const [lastInbound] = await tx.select().from(messages).where(and(eq(messages.conversationId, conv.id), eq(messages.direction, "inbound"))).orderBy(desc(messages.sentAt)).limit(1);
  const to = replyRecipients(lastInbound);
  if (!to[0]) return null;
  return { conversationId: conv.id, customerEmail: to[0], hasDraft: !!(conv.draftExternalId && conv.draftBody) };
}

function conversationIdOf(task: { input: unknown; plan: unknown }): string | null {
  const input = (task.input ?? {}) as Record<string, unknown>;
  if (typeof input.conversationId === "string") return input.conversationId;
  const steps = (task.plan as { steps?: { args?: { conversationId?: unknown } }[] } | null)?.steps ?? [];
  for (const step of steps) {
    if (typeof step.args?.conversationId === "string") return step.args.conversationId;
  }
  return null;
}

async function agentCanRun(tx: Tx, toolName: string): Promise<{ agentId: string; agentKind: string } | null> {
  const tool = getEngine().tools.get(toolName);
  if (!tool || tool.tier < 2) return null;
  const rows = await tx.select({ id: agents.id }).from(agents).where(eq(agents.status, "active"));
  for (const row of rows) {
    const loaded = await loadAgent(tx, { id: row.id });
    const max = loaded?.grant.maxTier.get(tool.name);
    if (loaded && loaded.grant.allowlist.includes(tool.name) && max !== undefined && max >= tool.tier) {
      return { agentId: loaded.agent.id, agentKind: loaded.agent.kind };
    }
  }
  return null;
}

export interface Artifact {
  id: string;
  title: string;
  /** Token only. The link expires. */
  token: string;
  expiresAt: string;
}

/** Titles shown in the library. Emails and provider keys are scrubbed before storage and again on read. */
export function redactForDisplay(value: string): string {
  const clean = String(scrubPii(value) ?? "").replace(/\s+/g, " ").trim();
  return clean.slice(0, 200);
}

export async function saveArtifact(input: { actorUserId: string; orgId: string; title: string; now?: Date }): Promise<Artifact> {
  const title = redactForDisplay(input.title).slice(0, 120);
  if (!title) throw new AppError("VALIDATION", "Name the document");
  const now = input.now ?? new Date();
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "kimi.artifact");
    const id = crypto.randomUUID();
    const token = crypto.randomUUID().replaceAll("-", "");
    const artifact: Artifact = { id, title, token, expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString() };
    await putJson(tx, input.orgId, input.actorUserId, `${ARTIFACT}${id}`, artifact);
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "kimi.artifact.save", target: `artifact:${id}`, tier: 1, outcome: "success" });
    return presentArtifact(artifact);
  });
}

export function artifactLinkOpen(artifact: Artifact, now = new Date()): boolean {
  return Date.parse(artifact.expiresAt) > now.getTime();
}

export async function readArtifactByToken(input: { actorUserId: string; orgId: string; token: string; now?: Date }): Promise<Artifact> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "kimi.artifact.read");
    const rows = await tx.select().from(memoryRecords).where(sql`${memoryRecords.scopeRef} LIKE 'kimi:artifact:%'`).limit(100);
    const found = rows.map((r) => parse<Artifact>(r.content)).find((a) => a?.token === input.token);
    if (!found || !artifactLinkOpen(found, input.now ?? new Date())) throw new AppError("NOT_FOUND", "That link has expired");
    return presentArtifact(found);
  });
}

function presentArtifact(artifact: Artifact): Artifact {
  return { ...artifact, title: redactForDisplay(artifact.title) || "Untitled" };
}

export async function notifyPrefs(input: { actorUserId: string; orgId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "kimi.notify");
    const [row] = await tx.select().from(memoryRecords).where(eq(memoryRecords.scopeRef, NOTIFY)).orderBy(desc(memoryRecords.createdAt)).limit(1);
    return parse<{ quietStart: number; quietEnd: number; cap: number }>(row?.content ?? "") ?? { quietStart: 21, quietEnd: 8, cap: 5 };
  });
}

export async function saveNotifyPrefs(input: { actorUserId: string; orgId: string; quietStart?: number; quietEnd?: number; cap?: number }) {
  const quietStart = clampHour(input.quietStart, 21);
  const quietEnd = clampHour(input.quietEnd, 8);
  const cap = Math.min(20, Math.max(1, Math.round(input.cap ?? 5)));
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "kimi.notify.save");
    await tx.delete(memoryRecords).where(eq(memoryRecords.scopeRef, NOTIFY));
    await putJson(tx, input.orgId, input.actorUserId, NOTIFY, { quietStart, quietEnd, cap });
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "kimi.notify.save", target: "memory:notify", tier: 1, outcome: "success", metadata: { quietStart, quietEnd, cap } });
    return { quietStart, quietEnd, cap };
  });
}

function clampHour(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.min(23, Math.max(0, Math.round(value)));
}

const MONEY_CAP = "kimi:money-cap";

export async function saveMoneyCap(input: { actorUserId: string; orgId: string; weeklyCapDollars?: number; weeklyCapCents?: number }) {
  const cents = input.weeklyCapDollars !== undefined ? Math.round(input.weeklyCapDollars * 100) : Math.round(input.weeklyCapCents ?? 0);
  const weeklyCapCents = Math.min(100_000_000, Math.max(0, cents));
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "kimi.money.cap");
    await tx.delete(memoryRecords).where(eq(memoryRecords.scopeRef, MONEY_CAP));
    await putJson(tx, input.orgId, input.actorUserId, MONEY_CAP, { weeklyCapCents, autoPay: false });
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "kimi.money.cap", target: "memory:money-cap", tier: 1, outcome: "success", metadata: { weeklyCapCents, autoPay: false } });
    return { weeklyCapCents, autoPay: false as const };
  });
}

export async function moneySnapshot(input: { actorUserId: string; orgId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "kimi.money");
    const rows = await tx
      .select({ status: invoices.status, amountDueCents: invoices.amountDueCents, createdAt: invoices.createdAt })
      .from(invoices)
      .where(gte(invoices.createdAt, since));
    const openCents = rows.filter((r) => r.status === "open").reduce((sum, r) => sum + r.amountDueCents, 0);
    const paidCents = rows.filter((r) => r.status === "paid").reduce((sum, r) => sum + r.amountDueCents, 0);
    const [capRow] = await tx.select().from(memoryRecords).where(eq(memoryRecords.scopeRef, MONEY_CAP)).orderBy(desc(memoryRecords.createdAt)).limit(1);
    const cap = parse<{ weeklyCapCents: number }>(capRow?.content ?? "");
    const digest = moneyDigest({ invoicedCents: openCents + paidCents, collectedCents: paidCents });
    return { ...digest, openCents, weeklyCapCents: cap?.weeklyCapCents ?? null, autoPay: false as const };
  });
}

export async function listGoals(input: { actorUserId: string; orgId: string }): Promise<Goal[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "kimi.goal.list");
    const rows = await tx.select().from(memoryRecords).where(sql`${memoryRecords.scopeRef} LIKE 'kimi:goal:%'`).orderBy(desc(memoryRecords.createdAt)).limit(20);
    return rows.map((r) => parse<Goal>(r.content)).filter((g): g is Goal => !!g);
  });
}

export async function listArtifacts(input: { actorUserId: string; orgId: string }): Promise<Artifact[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "kimi.artifact.list");
    const rows = await tx.select().from(memoryRecords).where(sql`${memoryRecords.scopeRef} LIKE 'kimi:artifact:%'`).orderBy(desc(memoryRecords.createdAt)).limit(50);
    return rows.map((r) => parse<Artifact>(r.content)).filter((a): a is Artifact => !!a).map(presentArtifact);
  });
}

const NOTIFY_SENT = "kimi:notify:sent:";

/**
 * The in-app delivery path. Quiet hours, the daily cap, and batching decide
 * what is shown now and what waits for the morning brief. Approvals are not
 * deleted; they are only grouped.
 */
export async function deliverNotifications<T extends { id: string; tier: number }>(input: { actorUserId: string; orgId: string; items: T[]; now?: Date }): Promise<{ now: T[]; brief: T[]; cap: number; quiet: boolean }> {
  const now = input.now ?? new Date();
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "kimi.notify.deliver");
    const [org] = await tx.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, input.orgId));
    const clock = localClock(now, org?.timezone || "America/New_York");
    const [prefRow] = await tx.select().from(memoryRecords).where(eq(memoryRecords.scopeRef, NOTIFY)).orderBy(desc(memoryRecords.createdAt)).limit(1);
    const prefs = parse<{ quietStart: number; quietEnd: number; cap: number }>(prefRow?.content ?? "") ?? { quietStart: 21, quietEnd: 8, cap: 5 };
    const scope = `${NOTIFY_SENT}${clock.day}`;
    const [sentRow] = await tx.select().from(memoryRecords).where(eq(memoryRecords.scopeRef, scope)).orderBy(desc(memoryRecords.createdAt)).limit(1);
    const sent = new Set(parse<string[]>(sentRow?.content ?? "") ?? []);
    const fresh = input.items.filter((item) => !sent.has(item.id));
    const classified = fresh.map((item) => ({ ...item, urgency: classifyUrgency({ money: item.tier >= 3, customerWaiting: item.tier === 2 }) }));
    const batched = batchNotifications(classified, { hour: clock.hour, alreadyToday: sent.size, cap: prefs.cap, quietStart: prefs.quietStart, quietEnd: prefs.quietEnd });
    const delivered = [...sent, ...batched.now.map((item) => item.id)];
    if (batched.now.length) {
      await tx.delete(memoryRecords).where(eq(memoryRecords.scopeRef, scope));
      await putJson(tx, input.orgId, input.actorUserId, scope, delivered);
    }
    const nowIds = new Set(delivered);
    const briefIds = new Set(batched.brief.map((item) => item.id));
    return {
      now: input.items.filter((item) => nowIds.has(item.id) && !briefIds.has(item.id)),
      brief: input.items.filter((item) => briefIds.has(item.id)),
      cap: prefs.cap,
      quiet: withinQuietHours(clock.hour, prefs.quietStart, prefs.quietEnd),
    };
  });
}

function localClock(now: Date, timeZone: string): { day: string; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const hour = Number(get("hour"));
    return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number.isFinite(hour) ? hour : now.getUTCHours() };
  } catch {
    return { day: now.toISOString().slice(0, 10), hour: now.getUTCHours() };
  }
}

export { approvalCard, type ApprovalCardView };
export type { SignalHit };
