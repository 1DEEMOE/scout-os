import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, approvalRequests, memoryRecords, suppressionList, tasks, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { checkEmailAllowed } from "../scout/consent";
import { AppError } from "../errors";
import { logger } from "../logger";
import { ANY_ROLE, MANAGERS, inOrg, requireRole, STAFF } from "../org/access";
import { getPack, type OutreachPurpose, type PackTemplate } from "../industries/packs";
import { readPackId } from "../industries/store";
import { approvalExpiryMs } from "../kimi/cards";
import { smsWindowOpen } from "./hours";
import { isStartKeyword, isStopKeyword, normalizePhone, smsPortForSend } from "./sms";
import { SmsRegistrationBlocked, effectiveFromNumber, sendSmsGuarded, smsRegistrationCheck } from "./sms-registration";

export type TemplateStatus = "ready_to_approve" | "approved";

export interface StagedTemplate {
  id: string;
  purpose: OutreachPurpose;
  channel: "email" | "sms";
  name: string;
  body: string;
  status: TemplateStatus;
  approvedBy?: string;
  approvedAt?: string;
}

export interface LeadRecord {
  id: string;
  source: "web_form" | "front_desk" | "email" | "sms" | "missed_call";
  externalKey: string;
  arrivedAt: string;
  name: string;
  email: string;
  phone: string;
  timezone: string;
  purpose: OutreachPurpose;
  outcome: "sent" | "queued" | "blocked" | "waiting_for_template";
  blockReason?: string;
  firstResponseAt?: string;
  templateId?: string;
  customBody?: string;
  approvalId?: string;
  /** Voicemail recording (Twilio URL) left by a missed caller, if any. */
  recordingUrl?: string;
  /** The number the customer contacted. Approved sends must go out from this same number. */
  smsFrom?: string;
  /** True when the send path is the labelled MOCK (no live provider configured). */
  mock: boolean;
}

type Actor = { actorUserId: string; orgId: string };

function scopeTemplate(id: string) {
  return `speed:template:${id}`;
}
function scopeLead(key: string) {
  return `speed:lead:${key}`;
}

async function put(tx: Tx, tenantId: string, userId: string, scopeRef: string, value: unknown) {
  const content = JSON.stringify(value);
  if (content.length > 2000) throw new AppError("VALIDATION", "That record is too long to store.");
  await tx.delete(memoryRecords).where(and(eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, scopeRef)));
  await tx.insert(memoryRecords).values({ tenantId, layer: "org", scopeRef, content, trust: "user", createdByUser: userId });
}

async function allScoped(tx: Tx, prefix: string): Promise<{ scopeRef: string; content: string }[]> {
  const rows = await tx.select({ scopeRef: memoryRecords.scopeRef, content: memoryRecords.content }).from(memoryRecords).where(eq(memoryRecords.layer, "org"));
  return rows.filter((r) => r.scopeRef.startsWith(prefix));
}

function parse<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export function renderTemplate(body: string, fields: { name?: string; business?: string }): string {
  return body.replace(/\{\{\s*name\s*\}\}/g, fields.name?.trim() || "there").replace(/\{\{\s*business\s*\}\}/g, fields.business?.trim() || "us");
}

/** Stage the pack's replies as ready to approve. Does not send anything. */
export async function stagePackTemplates(tx: Tx, tenantId: string, userId: string, packId: string): Promise<number> {
  const pack = getPack(packId);
  const existing = await allScoped(tx, "speed:template:");
  if (existing.length) return existing.length;
  for (const t of pack.templates) {
    const id = randomUUID();
    const row: StagedTemplate = { id, purpose: t.purpose, channel: t.channel, name: t.name, body: t.body, status: "ready_to_approve" };
    await put(tx, tenantId, userId, scopeTemplate(id), row);
  }
  await put(tx, tenantId, userId, "speed:menu", pack.services);
  await recordAudit(tx, { tenantId, actorType: "system", actorId: "onboarding", action: "speed.templates.stage", target: `organization:${tenantId}`, tier: 1, outcome: "success", metadata: { packId, templates: pack.templates.length, routines: pack.routines.map((r) => r.id), maxRoutineTier: 1 } });
  return pack.templates.length;
}

export async function listTemplates(input: Actor): Promise<StagedTemplate[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "speed.templates.list");
    const rows = await allScoped(tx, "speed:template:");
    return rows.map((r) => parse<StagedTemplate>(r.content)).filter((t): t is StagedTemplate => !!t);
  });
}

/** One human action: approve every staged reply. Tier 2, audited. Nothing is sent here. */
export async function approveAllTemplates(input: Actor): Promise<{ approved: number }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "speed.templates.approve");
    const rows = await allScoped(tx, "speed:template:");
    let approved = 0;
    for (const row of rows) {
      const t = parse<StagedTemplate>(row.content);
      if (!t || t.status === "approved") continue;
      const next: StagedTemplate = { ...t, status: "approved", approvedBy: input.actorUserId, approvedAt: new Date().toISOString() };
      await put(tx, input.orgId, input.actorUserId, row.scopeRef, next);
      approved++;
    }
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "speed.templates.approve_all",
      target: `organization:${input.orgId}`,
      tier: 2,
      outcome: "success",
      metadata: { approved },
    });
    logger.info({ orgId: input.orgId, actor: input.actorUserId, approved }, "reply templates approved");
    return { approved };
  });
}

async function stopped(tx: Tx, phone: string): Promise<boolean> {
  const rows = await allScoped(tx, "speed:stop:");
  return rows.some((r) => r.scopeRef === `speed:stop:${phone}`);
}

async function consented(tx: Tx, phone: string): Promise<boolean> {
  const [row] = await allScoped(tx, `speed:consent:${phone}`);
  return !!row;
}

export async function recordSmsConsent(input: Actor & { phone: string; evidence: string }): Promise<void> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new AppError("VALIDATION", "Enter a phone number with at least 10 digits.");
  if (input.evidence.trim().length < 8) throw new AppError("VALIDATION", "Say how they agreed to texts (at least a short note).");
  await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "speed.sms.consent");
    if (await stopped(tx, phone)) throw new AppError("CONFLICT", "That number asked us to stop. We won't text it.");
    await put(tx, input.orgId, input.actorUserId, `speed:consent:${phone}`, { at: new Date().toISOString(), evidence: input.evidence.trim().slice(0, 400) });
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "speed.sms.consent", target: `sms:${phone.slice(-4)}`, tier: 1, outcome: "success", metadata: { last4: phone.slice(-4) } });
  });
}

async function ensureAgent(tx: Tx, tenantId: string): Promise<string> {
  const [existing] = await tx.select({ id: agents.id }).from(agents).limit(1);
  if (existing) return existing.id;
  const [row] = await tx.insert(agents).values({ tenantId, kind: "inbox", displayName: "Inbox", status: "active" }).returning({ id: agents.id });
  return row!.id;
}

/** The shared inbox agent, for system-created tasks (e.g. voicemail follow-up). */
export async function ensureInboxAgent(tx: Tx, tenantId: string): Promise<string> {
  return ensureAgent(tx, tenantId);
}

async function queueCustom(tx: Tx, tenantId: string, userId: string, lead: LeadRecord): Promise<LeadRecord> {
  const agentId = await ensureAgent(tx, tenantId);
  const taskId = randomUUID();
  const approvalId = randomUUID();
  await tx.insert(tasks).values({
    id: taskId,
    tenantId,
    requestedBy: "system:speed-to-lead",
    assignedAgentId: agentId,
    intent: "Send a reply that is not a pre-approved template",
    title: "Reply waiting for your OK",
    state: "WAITING_FOR_APPROVAL",
    input: { leadId: lead.id },
  });
  await tx.insert(approvalRequests).values({
    id: approvalId,
    tenantId,
    taskId,
    agentId,
    toolName: "speed.send_message",
    tier: 2,
    actionDigest: createHash("sha256").update(`${tenantId}|${lead.id}|${lead.purpose}`).digest("hex"),
    payload: { leadId: lead.id, purpose: lead.purpose, channel: lead.phone ? "sms" : "email" },
    summary: lead.purpose === "first_response" ? "Send a first reply that isn't a pre-approved template" : "Send a follow-up that isn't a pre-approved template",
    expiresAt: new Date(Date.now() + approvalExpiryMs("system:speed-to-lead", Number(process.env.WOS_BACKGROUND_APPROVAL_MINUTES ?? 45))),
  });
  const next: LeadRecord = { ...lead, outcome: "queued", approvalId };
  await put(tx, tenantId, userId, scopeLead(lead.externalKey), next);
  await recordAudit(tx, { tenantId, actorType: "system", actorId: "speed-to-lead", action: "speed.reply.queue", target: `approval:${approvalId}`, tier: 2, outcome: "success", metadata: { leadId: lead.id, purpose: lead.purpose } });
  return next;
}

/**
 * The send gate. STOP and quiet hours always apply. Recorded consent is
 * required for everything we start (web forms, reminders, follow-ups); the
 * one exception is `inboundInitiated`: the customer just called or texted the
 * business themselves, so a single immediate reply is allowed without a
 * prior consent record. It never creates consent — follow-ups still need it.
 */
async function gate(tx: Tx, tenantId: string, lead: LeadRecord, channel: "email" | "sms", now: Date, opts?: { inboundInitiated?: boolean; smsFrom?: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (channel === "sms") {
    if (!lead.phone) return { ok: false, reason: "no_phone" };
    if (await stopped(tx, lead.phone)) return { ok: false, reason: "stop" };
    if (!opts?.inboundInitiated && !(await consented(tx, lead.phone))) return { ok: false, reason: "no_consent" };
    if (!smsWindowOpen(now, lead.timezone)) return { ok: false, reason: "quiet_hours" };
    const reg = await smsRegistrationCheck(tx, tenantId, opts?.smsFrom);
    if (!reg.ok) return { ok: false, reason: reg.reason ?? "sms_registration_unverified" };
    return { ok: true };
  }
  if (lead.email) {
    const [blocked] = await tx.select({ v: suppressionList.value }).from(suppressionList).where(and(eq(suppressionList.channel, "email"), eq(suppressionList.value, lead.email)));
    if (blocked) return { ok: false, reason: "suppressed" };
    const check = await checkEmailAllowed(tx, [lead.email]);
    if (!check.allowed) return { ok: false, reason: check.reason };
  }
  return { ok: true };
}

export interface IngestLeadInput {
  source: LeadRecord["source"];
  externalKey: string;
  name?: string;
  email?: string;
  phone?: string;
  timezone?: string;
  purpose?: OutreachPurpose;
  customBody?: string;
  businessName?: string;
  now?: Date;
  /** Number the customer contacted; beats TWILIO_FROM_NUMBER for the reply. */
  smsFrom?: string;
  /**
   * The customer contacted the business first (called or texted in). A single
   * immediate reply is then allowed without a prior consent record; STOP and
   * quiet hours still apply, and no consent is created. Set only by
   * authenticated inbound-channel handlers (e.g. the Twilio webhook).
   */
  inboundInitiated?: boolean;
  /**
   * Record the lead but do not send, with this block reason. Used to stop
   * text-back loops when the same phone already got a reply recently.
   */
  suppressSend?: string;
}

/** A new lead. Sends only when a person has already approved a matching template and the gates pass. */
export async function ingestLead(input: Actor & IngestLeadInput): Promise<LeadRecord> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "speed.lead.ingest");
    return ingestLeadCore(tx, input.orgId, input.actorUserId, input);
  });
}

/**
 * Role-checked callers use ingestLead. This core is for system paths that
 * already authenticated the inbound channel themselves (provider signature +
 * channel token), e.g. the Twilio webhook. `createdBy` names that system.
 */
export async function ingestLeadCore(tx: Tx, tenantId: string, createdBy: string, input: IngestLeadInput): Promise<LeadRecord> {
  const now = input.now ?? new Date();
  const portMock = smsPortForSend(input.smsFrom).mock;
  const key = input.externalKey.slice(0, 80);
  const prior = (await allScoped(tx, scopeLead(key)))[0];
  if (prior) {
    const existing = parse<LeadRecord>(prior.content);
    if (existing) return existing;
  }
  const phone = input.phone ? normalizePhone(input.phone) ?? "" : "";
  if (phone && isStopKeyword(input.customBody ?? "")) {
    await put(tx, tenantId, createdBy, `speed:stop:${phone}`, { at: now.toISOString() });
    await recordAudit(tx, { tenantId, actorType: "system", actorId: "speed-to-lead", action: "speed.sms.stop", target: `sms:${phone.slice(-4)}`, tier: 1, outcome: "success", metadata: { last4: phone.slice(-4) } });
    const stoppedLead: LeadRecord = {
      id: randomUUID(), source: input.source, externalKey: key, arrivedAt: now.toISOString(), name: (input.name ?? "").slice(0, 80),
      email: "", phone, timezone: input.timezone || "America/New_York", purpose: "first_response", outcome: "blocked" as const, blockReason: "stop", mock: portMock,
    };
    await put(tx, tenantId, createdBy, scopeLead(key), stoppedLead);
    return stoppedLead;
  }
  const purpose = input.purpose ?? "first_response";
  const lead: LeadRecord = {
    id: randomUUID(),
    source: input.source,
    externalKey: key,
    arrivedAt: now.toISOString(),
    name: (input.name ?? "").slice(0, 80),
    email: (input.email ?? "").trim().toLowerCase().slice(0, 120),
    phone,
    timezone: input.timezone || "America/New_York",
    purpose,
    outcome: "waiting_for_template",
    smsFrom: effectiveFromNumber(input.smsFrom) ?? undefined,
    mock: portMock,
  };
  const templates = (await allScoped(tx, "speed:template:")).map((r) => parse<StagedTemplate>(r.content)).filter((t): t is StagedTemplate => !!t);
  const channel: "email" | "sms" = phone && !lead.email ? "sms" : phone && purpose !== "first_response" ? "sms" : lead.email ? "email" : "sms";
  const match = templates.find((t) => t.status === "approved" && t.purpose === purpose && t.channel === channel);
  if (input.customBody) {
    lead.customBody = input.customBody.slice(0, 500);
    return queueCustom(tx, tenantId, createdBy, lead);
  }
  if (!match) {
    await put(tx, tenantId, createdBy, scopeLead(key), lead);
    return lead;
  }
  if (input.suppressSend) {
    const suppressed: LeadRecord = { ...lead, outcome: "blocked", blockReason: input.suppressSend, templateId: match.id };
    await put(tx, tenantId, createdBy, scopeLead(key), suppressed);
    await recordAudit(tx, { tenantId, actorType: "system", actorId: "speed-to-lead", action: "speed.reply.blocked", target: `lead:${lead.id}`, tier: 2, outcome: "denied", metadata: { reason: input.suppressSend, purpose, suppressed: true } });
    return suppressed;
  }
  const g = await gate(tx, tenantId, lead, channel, now, { inboundInitiated: input.inboundInitiated, smsFrom: lead.smsFrom });
  if (!g.ok) {
    const blocked: LeadRecord = { ...lead, outcome: "blocked", blockReason: g.reason, templateId: match.id };
    await put(tx, tenantId, createdBy, scopeLead(key), blocked);
    await recordAudit(tx, { tenantId, actorType: "system", actorId: "speed-to-lead", action: "speed.reply.blocked", target: `lead:${lead.id}`, tier: 2, outcome: "denied", metadata: { reason: g.reason, purpose } });
    return blocked;
  }
  const body = renderTemplate(match.body, { name: lead.name, business: input.businessName });
  let sentMock = portMock;
  if (channel === "sms") {
    try {
      sentMock = (await sendSmsGuarded(tx, tenantId, lead.smsFrom, { to: lead.phone, body, idempotencyKey: `lead:${lead.id}` })).mock;
    } catch (e) {
      if (!(e instanceof SmsRegistrationBlocked)) throw e;
      const blocked: LeadRecord = { ...lead, outcome: "blocked", blockReason: e.reason, templateId: match.id };
      await put(tx, tenantId, createdBy, scopeLead(key), blocked);
      await recordAudit(tx, { tenantId, actorType: "system", actorId: "speed-to-lead", action: "speed.reply.blocked", target: `lead:${lead.id}`, tier: 2, outcome: "denied", metadata: { reason: e.reason, purpose, atSendBoundary: true } });
      return blocked;
    }
  }
  const sent: LeadRecord = { ...lead, outcome: "sent", templateId: match.id, firstResponseAt: now.toISOString(), mock: sentMock };
  await put(tx, tenantId, createdBy, scopeLead(key), sent);
  await recordAudit(tx, { tenantId, actorType: "system", actorId: "speed-to-lead", action: "speed.reply.send", target: `lead:${lead.id}`, tier: 2, outcome: "success", metadata: { templateId: match.id, purpose, preApproved: true, mock: sentMock, seconds: 0 } });
  return sent;
}

export async function speedSummary(input: Actor): Promise<{ leads: number; within60: number; label: "respond-in-60s" }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "speed.summary");
    const leads = (await allScoped(tx, "speed:lead:")).map((r) => parse<LeadRecord>(r.content)).filter((l): l is LeadRecord => !!l && l.purpose === "first_response");
    const within60 = leads.filter((l) => l.firstResponseAt && Date.parse(l.firstResponseAt) - Date.parse(l.arrivedAt) <= 60_000).length;
    return { leads: leads.length, within60, label: "respond-in-60s" };
  });
}

export async function workspacePack(input: Actor): Promise<{ packId: string | null; menu: PackTemplate[] | unknown; templateCount: number }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "speed.pack");
    const packId = await readPackId(tx);
    const [menu] = await allScoped(tx, "speed:menu");
    const templateCount = (await allScoped(tx, "speed:template:")).length;
    return { packId, menu: menu ? parse(menu.content) : [], templateCount };
  });
}

/** After a person approves a queued custom reply. Consent and quiet hours still apply. */
export async function fulfillSpeedApproval(tx: Tx, tenantId: string, leadId: string, now = new Date()): Promise<void> {
  const rows = await allScoped(tx, "speed:lead:");
  const row = rows.find((r) => parse<LeadRecord>(r.content)?.id === leadId);
  const lead = row ? parse<LeadRecord>(row.content) : null;
  if (!row || !lead) return;
  const channel: "email" | "sms" = lead.phone && !lead.email ? "sms" : "email";
  const g = await gate(tx, tenantId, lead, channel, now, { smsFrom: lead.smsFrom });
  const taskUpdate = async (state: "COMPLETED" | "FAILED") => {
    if (!lead.approvalId) return;
    const [ap] = await tx.select({ taskId: approvalRequests.taskId }).from(approvalRequests).where(eq(approvalRequests.id, lead.approvalId));
    if (ap) await tx.update(tasks).set({ state, updatedAt: new Date() }).where(eq(tasks.id, ap.taskId));
  };
  if (!g.ok) {
    await put(tx, tenantId, "system:speed-to-lead", row.scopeRef, { ...lead, outcome: "blocked", blockReason: g.reason });
    await taskUpdate("FAILED");
    await recordAudit(tx, { tenantId, actorType: "system", actorId: "speed-to-lead", action: "speed.reply.blocked", target: `lead:${lead.id}`, tier: 2, outcome: "denied", metadata: { reason: g.reason } });
    return;
  }
  if (channel === "sms" && lead.customBody) {
    try {
      await sendSmsGuarded(tx, tenantId, lead.smsFrom, { to: lead.phone, body: lead.customBody, idempotencyKey: `lead:${lead.id}` });
    } catch (e) {
      if (!(e instanceof SmsRegistrationBlocked)) throw e;
      await put(tx, tenantId, "system:speed-to-lead", row.scopeRef, { ...lead, outcome: "blocked", blockReason: e.reason });
      await taskUpdate("FAILED");
      await recordAudit(tx, { tenantId, actorType: "system", actorId: "speed-to-lead", action: "speed.reply.blocked", target: `lead:${lead.id}`, tier: 2, outcome: "denied", metadata: { reason: e.reason, atSendBoundary: true } });
      return;
    }
  }
  await put(tx, tenantId, "system:speed-to-lead", row.scopeRef, { ...lead, outcome: "sent", firstResponseAt: now.toISOString() });
  await taskUpdate("COMPLETED");
}

export async function closeSpeedApproval(tx: Tx, tenantId: string, leadId: string): Promise<void> {
  const rows = await allScoped(tx, "speed:lead:");
  const row = rows.find((r) => parse<LeadRecord>(r.content)?.id === leadId);
  const lead = row ? parse<LeadRecord>(row.content) : null;
  if (!row || !lead?.approvalId) return;
  const [ap] = await tx.select({ taskId: approvalRequests.taskId }).from(approvalRequests).where(eq(approvalRequests.id, lead.approvalId));
  if (ap) await tx.update(tasks).set({ state: "FAILED", updatedAt: new Date() }).where(eq(tasks.id, ap.taskId));
  await put(tx, tenantId, "system:speed-to-lead", row.scopeRef, { ...lead, outcome: "blocked", blockReason: "declined" });
}

/* ------------------------------------------------------------------ */
/* Missed-call answering + inbound SMS (Twilio webhook entry points)   */
/* ------------------------------------------------------------------ */

/** A second text-back inside this window would be a loop, not a service. */
export const TEXTBACK_WINDOW_MS = 24 * 3_600_000;

/** STOP from the provider webhook: hard-block the number. System actor — the caller authenticated via the provider signature, not a login. */
export async function systemRecordSmsStop(tx: Tx, tenantId: string, phoneRaw: string, now = new Date()): Promise<void> {
  const phone = normalizePhone(phoneRaw);
  if (!phone) return;
  await put(tx, tenantId, "system:twilio", `speed:stop:${phone}`, { at: now.toISOString() });
  await recordAudit(tx, { tenantId, actorType: "system", actorId: "twilio", action: "speed.sms.stop", target: `sms:${phone.slice(-4)}`, tier: 1, outcome: "success", metadata: { last4: phone.slice(-4), via: "twilio_webhook" } });
}

/** START clears the block and records express consent: they texted START to the business line. */
export async function systemRecordSmsStart(tx: Tx, tenantId: string, phoneRaw: string, now = new Date()): Promise<void> {
  const phone = normalizePhone(phoneRaw);
  if (!phone) return;
  await tx.delete(memoryRecords).where(and(eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, `speed:stop:${phone}`)));
  await put(tx, tenantId, "system:twilio", `speed:consent:${phone}`, { at: now.toISOString(), evidence: "Texted START to the business line" });
  await recordAudit(tx, { tenantId, actorType: "system", actorId: "twilio", action: "speed.sms.start", target: `sms:${phone.slice(-4)}`, tier: 1, outcome: "success", metadata: { last4: phone.slice(-4), via: "twilio_webhook" } });
}

/** The lead stored under this exact external key, if any (webhook idempotency). */
export async function findLeadByExternalKey(tx: Tx, key: string): Promise<LeadRecord | null> {
  const row = (await allScoped(tx, scopeLead(key.slice(0, 80))))[0];
  return row ? parse<LeadRecord>(row.content) : null;
}

/** True when this phone got a text from us inside the window — stops text-back loops. */
export async function findRecentSentToPhone(tx: Tx, phone: string, withinMs: number, now = new Date()): Promise<boolean> {
  const cutoff = now.getTime() - withinMs;
  const rows = await allScoped(tx, "speed:lead:");
  return rows.some((r) => {
    const l = parse<LeadRecord>(r.content);
    return !!l && l.phone === phone && l.outcome === "sent" && !!l.firstResponseAt && Date.parse(l.firstResponseAt) >= cutoff;
  });
}

async function createInboxTask(tx: Tx, tenantId: string, t: { title: string; intent: string; input: Record<string, unknown> }): Promise<string> {
  const agentId = await ensureAgent(tx, tenantId);
  const taskId = randomUUID();
  await tx.insert(tasks).values({
    id: taskId,
    tenantId,
    requestedBy: "system:twilio",
    assignedAgentId: agentId,
    intent: t.intent.slice(0, 200),
    title: t.title.slice(0, 200),
    state: "REQUESTED",
    input: t.input,
  });
  return taskId;
}

export interface MissedCallInput {
  /** Provider call ID — the idempotency key, so webhook retries are safe. */
  callSid: string;
  /** The caller. */
  from: string;
  /** The business line they called; the text-back comes from this number. */
  to: string;
  businessName?: string;
  timezone?: string;
  recordingUrl?: string;
  recordingDurationSec?: number;
  now?: Date;
}

export interface MissedCallResult {
  lead: LeadRecord;
  voicemailTaskId?: string;
}

/**
 * A call the business did not answer. Files the lead (idempotent by call ID),
 * sends ONE text-back through the pre-approved first-reply template when the
 * gates pass, attaches any voicemail and opens a follow-up task for a person.
 * The text-back is inbound-initiated: they called first. A second call from
 * the same number inside TEXTBACK_WINDOW_MS is recorded but not texted again.
 */
export async function missedCallReceived(tx: Tx, tenantId: string, input: MissedCallInput): Promise<MissedCallResult> {
  const now = input.now ?? new Date();
  const phone = normalizePhone(input.from);
  const recent = phone ? await findRecentSentToPhone(tx, phone, TEXTBACK_WINDOW_MS, now) : false;
  const lead = await ingestLeadCore(tx, tenantId, "system:twilio", {
    source: "missed_call",
    externalKey: `twilio:call:${input.callSid.slice(0, 60)}`,
    phone: phone ?? "",
    timezone: input.timezone,
    purpose: "first_response",
    businessName: input.businessName,
    smsFrom: normalizePhone(input.to) ?? undefined,
    inboundInitiated: true,
    suppressSend: recent ? "recent_textback" : undefined,
    now,
  });
  let out = lead;
  let voicemailTaskId: string | undefined;
  const url = input.recordingUrl?.trim();
  if (url && !lead.recordingUrl) {
    out = { ...lead, recordingUrl: url.slice(0, 300) };
    await put(tx, tenantId, "system:twilio", scopeLead(lead.externalKey), out);
    voicemailTaskId = await createInboxTask(tx, tenantId, {
      title: `Missed call — voicemail from ${phone ? `•••${phone.slice(-4)}` : "unknown caller"}`,
      intent: "Listen to the voicemail and call the customer back",
      input: { leadId: lead.id, recordingUrl: out.recordingUrl, phone: phone ?? "", durationSec: input.recordingDurationSec ?? null },
    });
  }
  await recordAudit(tx, {
    tenantId,
    actorType: "system",
    actorId: "twilio",
    action: "voice.missed_call",
    target: `lead:${out.id}`,
    tier: 1,
    outcome: "success",
    metadata: { textback: out.outcome, voicemail: !!url, last4: phone?.slice(-4) ?? null },
  });
  return { lead: out, voicemailTaskId };
}

export interface InboundSmsInput {
  /** Provider message ID — the idempotency key. */
  messageSid: string;
  from: string;
  /** The business line they texted; any reply comes from this number. */
  to: string;
  body: string;
  businessName?: string;
  timezone?: string;
  now?: Date;
}

export interface InboundSmsResult {
  action: "stopped" | "started" | "received";
  lead?: LeadRecord;
  taskId?: string;
}

/**
 * A text sent to the business line. STOP/START update the consent ledger and
 * are never replied to by us (Twilio sends its own confirmation). Anything
 * else is filed as a lead — idempotent by message ID — and surfaces as a task
 * so a person takes over the thread; the pre-approved first reply fires at
 * most once per phone per TEXTBACK_WINDOW_MS.
 */
export async function inboundSmsReceived(tx: Tx, tenantId: string, input: InboundSmsInput): Promise<InboundSmsResult> {
  const now = input.now ?? new Date();
  const phone = normalizePhone(input.from);
  if (!phone) {
    await recordAudit(tx, { tenantId, actorType: "system", actorId: "twilio", action: "sms.inbound.rejected", target: `sms:unknown`, tier: 1, outcome: "denied", metadata: { reason: "unparseable_from" } });
    return { action: "received" };
  }
  if (isStopKeyword(input.body)) {
    await systemRecordSmsStop(tx, tenantId, phone, now);
    return { action: "stopped" };
  }
  if (isStartKeyword(input.body)) {
    await systemRecordSmsStart(tx, tenantId, phone, now);
    return { action: "started" };
  }
  const key = `twilio:sms:${input.messageSid.slice(0, 60)}`;
  // A webhook retry of a message we already filed must not open a second task.
  const prior = await findLeadByExternalKey(tx, key);
  if (prior) return { action: "received", lead: prior };
  const recent = await findRecentSentToPhone(tx, phone, TEXTBACK_WINDOW_MS, now);
  const lead = await ingestLeadCore(tx, tenantId, "system:twilio", {
    source: "sms",
    externalKey: key,
    phone,
    timezone: input.timezone,
    purpose: "first_response",
    businessName: input.businessName,
    smsFrom: normalizePhone(input.to) ?? undefined,
    inboundInitiated: true,
    suppressSend: recent ? "recent_textback" : undefined,
    now,
  });
  const taskId = await createInboxTask(tx, tenantId, {
    title: `Text from •••${phone.slice(-4)}`,
    intent: "Read the customer's text and reply in the thread",
    input: { leadId: lead.id, phone, body: input.body.slice(0, 500) },
  });
  return { action: "received", lead, taskId };
}
