/**
 * Public lead-capture form ("Contact us") for the business's own website.
 *
 * Deliberately shares the front-desk channel token instead of issuing a
 * second public credential: there is exactly one public capability to guard,
 * and pausing the front desk closes the lead form too. The form is OFF by
 * default and a manager turns it on in settings.
 *
 * Submissions are unauthenticated, so the defenses live here: honeypot,
 * per-IP rate limits (counted in their own committed transaction so failed
 * attempts still count), daily abuse cap, and 24h dedupe so a double-submit
 * doesn't open two deals. A submission upserts the contact, opens one
 * pipeline deal (source web_form), and files the message as a note — no
 * approvals needed because nothing leaves the workspace (tier 0 audit).
 *
 * Interim store: config at memory_records scopeRef `leadform:config` until
 * proposed 0027_crm_pipeline.sql is reviewed. Until then, form-sourced
 * contacts carry source 'inbox' (the applied contacts_source CHECK has no
 * 'web_form' value yet; 0027 widens it).
 */
import { randomUUID } from "node:crypto";
import { asc, desc, eq, sql } from "drizzle-orm";
import { contacts, frontDeskChannels, memoryRecords, withTenant, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { bumpRate, getChannelByToken, hashIp } from "../front-desk/service";
import { ANY_ROLE, inOrg, MANAGERS, requireRole } from "../org/access";
import { insertDealTx, listDealsTx, OPEN_STAGES } from "./pipeline";
import { LEAD_FORM_NOTE_PREFIX } from "./timeline";

const REF_PREFIX = "leadform:";
const CONFIG_REF = `${REF_PREFIX}config`;

const PER_WINDOW = 10;
const WINDOW_MS = 60_000;
const ABUSE_PER_DAY = 50;
const DEDUPE_WINDOW_MS = 24 * 3_600_000;

export interface LeadFormConfig {
  v: 1;
  enabled: boolean;
  intro: string;
  successMessage: string;
  askPhone: boolean;
  askCompany: boolean;
  askMessage: boolean;
}

export const DEFAULT_LEAD_FORM: LeadFormConfig = {
  v: 1,
  enabled: false,
  intro: "",
  successMessage: "Thanks — we'll be in touch shortly.",
  askPhone: true,
  askCompany: true,
  askMessage: true,
};

function parseConfig(content: string): LeadFormConfig | null {
  try {
    const v = JSON.parse(content) as LeadFormConfig;
    return v && v.v === 1 && typeof v.enabled === "boolean" ? v : null;
  } catch {
    return null;
  }
}

async function readConfigTx(tx: Tx, tenantId: string): Promise<LeadFormConfig> {
  const rows = await tx
    .select({ content: memoryRecords.content })
    .from(memoryRecords)
    .where(sql`${memoryRecords.tenantId} = ${tenantId} AND ${memoryRecords.layer} = 'org' AND ${memoryRecords.scopeRef} = ${CONFIG_REF}`)
    .orderBy(desc(memoryRecords.createdAt))
    .limit(1);
  return (rows[0] && parseConfig(rows[0].content)) || { ...DEFAULT_LEAD_FORM };
}

async function writeConfigTx(tx: Tx, tenantId: string, cfg: LeadFormConfig, actorUserId: string): Promise<void> {
  const content = JSON.stringify(cfg);
  if (content.length > 2000) throw new AppError("VALIDATION", "Lead form settings are too large to store.");
  await tx.delete(memoryRecords).where(sql`${memoryRecords.tenantId} = ${tenantId} AND ${memoryRecords.layer} = 'org' AND ${memoryRecords.scopeRef} = ${CONFIG_REF}`);
  await tx.insert(memoryRecords).values({ tenantId, layer: "org", scopeRef: CONFIG_REF, content, trust: "verified", createdByUser: actorUserId });
}

/* ---------------------------------------------------------- settings */

export async function getLeadFormSettings(input: { actorUserId: string; orgId: string }): Promise<{
  channel: { id: string; displayName: string; status: string } | null;
  form: LeadFormConfig;
}> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "crm.leadform.read");
    // Direct read, NOT listFrontDeskChannels: that would nest a second inOrg
    // (and a second pooled connection) inside this one. Never select tokenHash.
    const [ch] = await tx
      .select({ id: frontDeskChannels.id, displayName: frontDeskChannels.displayName, status: frontDeskChannels.status })
      .from(frontDeskChannels)
      .orderBy(asc(frontDeskChannels.createdAt))
      .limit(1);
    const form = await readConfigTx(tx, input.orgId);
    return { channel: ch ?? null, form };
  });
}

export async function saveLeadFormSettings(input: {
  actorUserId: string;
  orgId: string;
  channelId: string;
  form: Partial<Omit<LeadFormConfig, "v">>;
}): Promise<{ saved: true }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "crm.leadform.save");
    const [ch] = await tx.select({ id: frontDeskChannels.id }).from(frontDeskChannels).where(eq(frontDeskChannels.id, input.channelId));
    if (!ch) throw new AppError("NOT_FOUND", "Front desk channel not found");
    const current = await readConfigTx(tx, input.orgId);
    const next: LeadFormConfig = {
      ...current,
      ...(input.form.enabled !== undefined ? { enabled: input.form.enabled === true } : {}),
      ...(input.form.intro !== undefined ? { intro: input.form.intro.trim().slice(0, 300) } : {}),
      ...(input.form.successMessage !== undefined ? { successMessage: input.form.successMessage.trim().slice(0, 300) || DEFAULT_LEAD_FORM.successMessage } : {}),
      ...(input.form.askPhone !== undefined ? { askPhone: input.form.askPhone === true } : {}),
      ...(input.form.askCompany !== undefined ? { askCompany: input.form.askCompany === true } : {}),
      ...(input.form.askMessage !== undefined ? { askMessage: input.form.askMessage === true } : {}),
    };
    await writeConfigTx(tx, input.orgId, next, input.actorUserId);
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "crm.leadform.save",
      target: `front_desk_channel:${ch.id}`,
      tier: 1,
      outcome: "success",
      metadata: { enabled: next.enabled },
    });
    return { saved: true };
  });
}

/* ------------------------------------------------------------ public */

export interface PublicLeadForm {
  businessName: string;
  disclosure: string;
  intro: string;
  successMessage: string;
  askPhone: boolean;
  askCompany: boolean;
  askMessage: boolean;
}

export async function getPublicLeadForm(publicToken: string): Promise<PublicLeadForm> {
  const ch = await getChannelByToken(publicToken);
  if (!ch || ch.status !== "active") throw new AppError("NOT_FOUND", "Form not found");
  return withTenant(ch.tenantId, async (tx) => {
    const cfg = await readConfigTx(tx, ch.tenantId);
    if (!cfg.enabled) throw new AppError("NOT_FOUND", "Form not found");
    return {
      businessName: ch.displayName,
      disclosure: ch.disclosure,
      intro: cfg.intro,
      successMessage: cfg.successMessage,
      askPhone: cfg.askPhone,
      askCompany: cfg.askCompany,
      askMessage: cfg.askMessage,
    };
  });
}

export interface LeadSubmission {
  publicToken: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  message?: string;
  /** Honeypot: a human never fills this. */
  website?: string;
  sourceIp: string;
}

export async function submitLeadForm(input: LeadSubmission): Promise<{ ok: true }> {
  // Honeypot: bots that fill the hidden field get a plausible success and nothing is stored.
  if (input.website && input.website.trim()) return { ok: true };

  const name = input.name.trim().slice(0, 120);
  if (!name) throw new AppError("VALIDATION", "Your name is required");
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError("VALIDATION", "Invalid email");
  const local = email.split("@")[0] ?? "";
  if (local.length > 40) throw new AppError("VALIDATION", "Email looks invalid");

  const ch = await getChannelByToken(input.publicToken);
  if (!ch || ch.status !== "active") throw new AppError("NOT_FOUND", "Form not found");

  // Count the attempt in its own committed transaction BEFORE storing, so
  // rate buckets survive a later failure (same lesson as front-desk bookings).
  const ipHash = hashIp(input.sourceIp || "unknown");
  const windowStart = new Date(Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS);
  const dayStart = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const limited = await withTenant(ch.tenantId, async (tx) => {
    const perIp = await bumpRate(tx, ch.tenantId, ch.id, `lead:ip:${ipHash}`, windowStart);
    const perDay = await bumpRate(tx, ch.tenantId, ch.id, `lead:day:${ipHash}`, dayStart);
    const reason = perIp > PER_WINDOW ? "per_ip_window" : perDay > ABUSE_PER_DAY ? "per_ip_day" : null;
    if (reason && (reason === "per_ip_window" ? perIp === PER_WINDOW + 1 : perDay === ABUSE_PER_DAY + 1)) {
      await recordAudit(tx, {
        tenantId: ch.tenantId,
        actorType: "system",
        actorId: "lead_form",
        action: "crm.leadform.rate_limited",
        target: `front_desk_channel:${ch.id}`,
        tier: 0,
        outcome: "denied",
        metadata: { reason },
      });
    }
    return reason;
  });
  if (limited === "per_ip_window") throw new AppError("RATE_LIMITED", "Too many submissions. Try again shortly.");
  if (limited === "per_ip_day") throw new AppError("RATE_LIMITED", "Daily submission limit reached for this network.");

  return withTenant(ch.tenantId, async (tx) => {
    const cfg = await readConfigTx(tx, ch.tenantId);
    if (!cfg.enabled) throw new AppError("NOT_FOUND", "Form not found");

    // Upsert the contact on lowercase email. Interim source is 'inbox' until
    // proposed 0027 adds 'web_form' to the contacts_source CHECK.
    const phone = input.phone?.trim().slice(0, 40) || null;
    const company = input.company?.trim().slice(0, 120) || null;
    const [existing] = await tx.select().from(contacts).where(sql`lower(${contacts.email}) = ${email}`).limit(1);
    let contactId: string;
    if (existing) {
      await tx
        .update(contacts)
        .set({
          name: existing.name || name,
          ...(phone ? { phone } : {}),
          ...(company ? { company } : {}),
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, existing.id));
      contactId = existing.id;
    } else {
      const [row] = await tx
        .insert(contacts)
        .values({ tenantId: ch.tenantId, name, email, phone, company, source: "inbox" })
        .returning({ id: contacts.id });
      contactId = row!.id;
    }

    // One open web-form deal per contact per day: a double-submit (or a bot
    // under the rate cap) updates the note but doesn't stack deals.
    const cutoff = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
    const deals = await listDealsTx(tx, ch.tenantId);
    const dupe = deals.some(
      (d) => d.contactId === contactId && d.source === "web_form" && (OPEN_STAGES as readonly string[]).includes(d.stage) && d.createdAt >= cutoff,
    );
    let dealCreated = false;
    if (!dupe) {
      await insertDealTx(tx, {
        tenantId: ch.tenantId,
        contactId,
        name: `${company || name} — web form`,
        amountCents: null,
        stage: "lead",
        source: "web_form",
        createdBy: "lead-form",
      });
      dealCreated = true;
    }

    const message = input.message?.trim().slice(0, 1000) ?? "";
    if (message) {
      const noteId = randomUUID();
      await tx.insert(memoryRecords).values({
        tenantId: ch.tenantId,
        layer: "org",
        scopeRef: `note:${contactId}:${noteId}`,
        content: JSON.stringify({
          v: 1,
          id: noteId,
          tenantId: ch.tenantId,
          contactId,
          body: `${LEAD_FORM_NOTE_PREFIX} ${message}`,
          createdBy: "lead-form",
          createdAt: new Date().toISOString(),
        }),
        trust: "verified",
        createdByUser: "lead-form",
      });
    }

    await recordAudit(tx, {
      tenantId: ch.tenantId,
      actorType: "system",
      actorId: "lead_form",
      action: "crm.leadform.submitted",
      target: `contact:${contactId}`,
      tier: 0,
      outcome: "success",
      // Never PII: no name, email, phone, message, or raw IP.
      metadata: { dealCreated, hasMessage: message.length > 0 },
    });
    return { ok: true as const };
  });
}
