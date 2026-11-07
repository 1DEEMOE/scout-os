import { and, desc, eq, sql } from "drizzle-orm";
import { memoryRecords, tasks, workflowExecutions, withTenant, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { listAuditEvents } from "../audit-log/service";
import { AppError } from "../errors";
import { scrubPii } from "../logger";
import { ANY_ROLE, inOrg, MANAGERS, requireRole, STAFF } from "../org/access";
import { getPack, type IndustryPack } from "../industries/packs";
import { ingestLead } from "../speed/service";
import { seasonalHits, type SignalHit } from "../signals/sources";
import { approvalCard, type ApprovalCardView } from "./cards";

const RULE = "kimi:rule:";
const PAUSE = "kimi:pause:";
const DRAFT = "kimi:draft:";
const ROUTINE = "kimi:routine:";
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

/** A suggestion the owner must explicitly save. Refused for money, irreversible, and tier >= 2. */
export async function saveSuggestedRule(input: { actorUserId: string; orgId: string; text: string; tier: number; toolName: string }): Promise<SavedRule> {
  const card = approvalCard({ summary: input.text, tier: input.tier, toolName: input.toolName });
  if (card.alwaysAllowBlocked || input.tier >= 2) {
    throw new AppError("FORBIDDEN", card.alwaysAllowBlocked ?? "That kind of action always needs a person.");
  }
  const text = input.text.trim().slice(0, 300);
  if (!text) throw new AppError("VALIDATION", "Write the rule in plain words");
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "kimi.rule.save");
    const id = crypto.randomUUID();
    const saved: SavedRule = { id, text, tier: input.tier, savedAt: new Date().toISOString() };
    await putJson(tx, input.orgId, input.actorUserId, `${RULE}${id}`, saved);
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "kimi.rule.save", target: `rule:${id}`, tier: 1, outcome: "success", metadata: { tier: input.tier } });
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
    const job = String(row.metadata.taskId ?? row.target ?? "workspace").slice(0, 80);
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

/** Hands the draft back. Does not send it. */
export async function handBack(input: { actorUserId: string; orgId: string; taskId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "kimi.handback");
    await tx.delete(memoryRecords).where(eq(memoryRecords.scopeRef, `${PAUSE}${input.taskId}`));
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "kimi.handback", target: `task:${input.taskId}`, tier: 1, outcome: "success", metadata: { sent: false } });
    return { handedBack: true, sent: false };
  });
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

export async function saveChatRoutine(input: { actorUserId: string; orgId: string; text: string }): Promise<ChatRoutine> {
  const parsed = parseChatRoutine(input.text);
  if ("refused" in parsed) throw new AppError("FORBIDDEN", parsed.refused);
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "kimi.routine");
    const id = crypto.randomUUID();
    const saved: ChatRoutine = { id, ...parsed, sends: false };
    await putJson(tx, input.orgId, input.actorUserId, `${ROUTINE}${id}`, saved);
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "kimi.routine.save", target: `routine:${id}`, tier: 1, outcome: "success", metadata: { maxTier: saved.maxTier, sends: false } });
    return saved;
  });
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

export async function firstRunFor(input: { actorUserId: string; orgId: string; businessName: string; packId: string }): Promise<FirstRunScript> {
  const script = firstRunScript({ businessName: input.businessName, packId: input.packId });
  const role = await inOrg(input.orgId, (tx) => requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "kimi.firstRun"));
  if (role === "viewer") return script;
  await ingestLead({
    actorUserId: input.actorUserId,
    orgId: input.orgId,
    source: "web_form",
    externalKey: "kimi-practice-lead",
    name: "MOCK neighbor",
    email: "mock-lead@example.test",
    customBody: script.lead.draft,
  });
  return script;
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

export function nextActionChips(job: string): { label: string; sends: false }[] {
  return [
    { label: `Draft a follow-up for ${job.slice(0, 80)}`, sends: false },
    { label: "Add a note to the customer record", sends: false },
  ];
}

export interface Artifact {
  id: string;
  title: string;
  /** Token only. The link expires. */
  token: string;
  expiresAt: string;
}

export async function saveArtifact(input: { actorUserId: string; orgId: string; title: string; now?: Date }): Promise<Artifact> {
  const title = input.title.trim().slice(0, 120);
  if (!title) throw new AppError("VALIDATION", "Name the document");
  const now = input.now ?? new Date();
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "kimi.artifact");
    const id = crypto.randomUUID();
    const token = crypto.randomUUID().replaceAll("-", "");
    const artifact: Artifact = { id, title, token, expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString() };
    await putJson(tx, input.orgId, input.actorUserId, `${ARTIFACT}${id}`, artifact);
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "kimi.artifact.save", target: `artifact:${id}`, tier: 1, outcome: "success" });
    return artifact;
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
    return found;
  });
}

export async function notifyPrefs(input: { actorUserId: string; orgId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "kimi.notify");
    const [row] = await tx.select().from(memoryRecords).where(eq(memoryRecords.scopeRef, NOTIFY)).limit(1);
    return parse<{ quietStart: number; quietEnd: number; cap: number }>(row?.content ?? "") ?? { quietStart: 21, quietEnd: 8, cap: 5 };
  });
}

export { approvalCard, type ApprovalCardView };
export type { SignalHit };
