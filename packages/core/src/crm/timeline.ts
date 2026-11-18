/**
 * Contact 360: everything we know about a person, assembled on read.
 *
 * The 360 is never stored — it is built from the systems of record (deals,
 * notes, synced CRM rows, invoices, inbox messages, jobs) every time, so it
 * can never disagree with them. Notes are the only new thing here, and they
 * are append-only (interim store: memory_records, scopeRef
 * `note:<contactId>:<noteId>`) until proposed 0027_crm_pipeline.sql lands;
 * even then the 0027 grants allow no UPDATE or DELETE on contact_notes.
 *
 * PII rule: note bodies and contact details never appear in audit metadata —
 * audits carry the note id and body length only.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { contacts, crmRecords, invoices, memoryRecords, messages, users, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { listJobRecordsTx } from "../jobs/service";
import { ANY_ROLE, inOrg, requireRole, STAFF } from "../org/access";
import { listDealsTx, OPEN_STAGES, readPipelineConfigTx, probabilityFor, type DealView } from "./pipeline";
import { scoreContact, type ContactScore } from "./scoring";

export const NOTE_PREFIX = "note:";
export const LEAD_FORM_NOTE_PREFIX = "Web lead form:";

export interface ContactNote {
  v: 1;
  id: string;
  tenantId: string;
  contactId: string;
  body: string;
  createdBy: string;
  createdAt: string;
}

export type ContactNoteView = ContactNote & { authorName: string | null };

/** Read inside an RLS-scoped tx — another org's contacts are invisible by construction. */
export async function readContactTx(tx: Tx, tenantId: string, contactId: string) {
  const [row] = await tx.select().from(contacts).where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)));
  if (!row) throw new AppError("NOT_FOUND", "Contact not found");
  return row;
}

function parseNote(content: string): ContactNote | null {
  try {
    const v = JSON.parse(content) as ContactNote;
    return v && v.v === 1 && typeof v.id === "string" && typeof v.contactId === "string" && typeof v.body === "string" ? v : null;
  } catch {
    return null;
  }
}

/** All notes for one contact, newest first. Storage-level: no role check. */
export async function listNotesTx(tx: Tx, tenantId: string, contactId: string): Promise<ContactNote[]> {
  const rows = await tx
    .select({ content: memoryRecords.content })
    .from(memoryRecords)
    .where(and(eq(memoryRecords.tenantId, tenantId), eq(memoryRecords.layer, "org"), like(memoryRecords.scopeRef, `${NOTE_PREFIX}${contactId}:%`)))
    .orderBy(desc(memoryRecords.createdAt))
    .limit(200);
  return rows.map((r) => parseNote(r.content)).filter((n): n is ContactNote => n !== null);
}

async function authorNames(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].slice(0, 100);
  if (!unique.length) return new Map();
  const rows = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function getContact(input: { actorUserId: string; orgId: string; contactId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "crm.contact.read");
    return readContactTx(tx, input.orgId, input.contactId);
  });
}

export type EnrichedContact = Awaited<ReturnType<typeof getContact>> & { openDealCount: number; score: ContactScore };

/**
 * Contacts with their open-deal count and score. The list view scores on
 * light facts only (no per-contact message scan — that would be 200 inbox
 * reads); the contact page runs the full fact set.
 */
export async function listContactsEnriched(input: { actorUserId: string; orgId: string }): Promise<EnrichedContact[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "crm.list");
    const rows = await tx.select().from(contacts).orderBy(desc(contacts.updatedAt)).limit(200);
    const deals = await listDealsTx(tx, input.orgId);
    return rows.map((c) => {
      const openDealCount = deals.filter((d) => d.contactId === c.id && (OPEN_STAGES as readonly string[]).includes(d.stage)).length;
      const score = scoreContact(
        { email: c.email, phone: c.phone, company: c.company, source: c.source },
        { hasOpenDeal: openDealCount > 0, lastActivityAt: c.updatedAt.toISOString(), inboundMessageCount: 0 },
      );
      return { ...c, openDealCount, score };
    });
  });
}

/** Adds an append-only note. Audit metadata carries id + length, never the body. */
export async function addContactNote(input: { actorUserId: string; orgId: string; contactId: string; body: string }): Promise<{ noteId: string }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "crm.note.add");
    await readContactTx(tx, input.orgId, input.contactId);
    const body = input.body.trim().slice(0, 1000);
    if (!body) throw new AppError("VALIDATION", "Note cannot be empty");
    const note: ContactNote = {
      v: 1,
      id: randomUUID(),
      tenantId: input.orgId,
      contactId: input.contactId,
      body,
      createdBy: input.actorUserId,
      createdAt: new Date().toISOString(),
    };
    const content = JSON.stringify(note);
    if (content.length > 2000) throw new AppError("VALIDATION", "Note is too long for the interim store.");
    await tx.insert(memoryRecords).values({
      tenantId: input.orgId,
      layer: "org",
      scopeRef: `${NOTE_PREFIX}${input.contactId}:${note.id}`,
      content,
      trust: "verified",
      createdByUser: input.actorUserId,
    });
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "crm.note.add",
      target: `contact:${input.contactId}`,
      tier: 0,
      outcome: "success",
      metadata: { noteId: note.id, length: body.length },
    });
    return { noteId: note.id };
  });
}

export interface TimelineEntry {
  kind: "note" | "deal" | "external_deal" | "invoice" | "message" | "job" | "lead_form";
  at: string;
  title: string;
  detail?: string;
  href?: string;
}

export interface Contact360 {
  contact: Awaited<ReturnType<typeof getContact>>;
  score: ContactScore;
  notes: ContactNoteView[];
  openDeals: DealView[];
  closedDeals: DealView[];
  timeline: TimelineEntry[];
}

/**
 * The full picture of one contact: score with reasons, notes with authors,
 * open and closed deals, and a merged timeline (newest first, capped at 100).
 */
export async function contact360(input: { actorUserId: string; orgId: string; contactId: string }): Promise<Contact360> {
  const contact = await getContact(input); // role gate + NOT_FOUND outside the org
  const contactId = input.contactId;
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "crm.contact.360");
    const email = contact.email?.trim().toLowerCase() ?? "";

    const config = await readPipelineConfigTx(tx, input.orgId);
    const allDeals = await listDealsTx(tx, input.orgId);
    const mine = allDeals.filter((d) => d.contactId === contactId);
    const toView = (d: (typeof mine)[number]): DealView => {
      const probabilityBps = probabilityFor(config, d.stage);
      return {
        ...d,
        contactName: contact.name || null,
        contactEmail: contact.email,
        probabilityBps,
        weightedCents: d.amountCents === null ? null : Math.round((d.amountCents * probabilityBps) / 10_000),
      };
    };
    const openDeals = mine.filter((d) => (OPEN_STAGES as readonly string[]).includes(d.stage)).map(toView);
    const closedDeals = mine.filter((d) => !(OPEN_STAGES as readonly string[]).includes(d.stage)).map(toView);

    const notes = await listNotesTx(tx, input.orgId, contactId);
    const names = await authorNames(tx, notes.map((n) => n.createdBy));
    const noteViews: ContactNoteView[] = notes.map((n) => ({ ...n, authorName: names.get(n.createdBy) ?? null }));

    const external = await tx.select().from(crmRecords).where(eq(crmRecords.contactId, contactId)).orderBy(desc(crmRecords.createdAt)).limit(50);

    const invoiceRows = await tx
      .select()
      .from(invoices)
      .where(email ? or(eq(invoices.contactId, contactId), sql`lower(${invoices.customerEmail}) = ${email}`) : eq(invoices.contactId, contactId))
      .orderBy(desc(invoices.createdAt))
      .limit(50);

    // Inbox: scan the recent window and match in JS (sender/recipients are
    // free-text; a lower() index is proposed-schema material, not interim).
    const recentMessages = email
      ? (await tx.select().from(messages).orderBy(desc(messages.sentAt)).limit(300)).filter(
          (m) => m.sender.trim().toLowerCase() === email || m.recipients.some((r) => r.trim().toLowerCase() === email),
        )
      : [];

    const jobs = email ? (await listJobRecordsTx(tx, input.orgId)).filter((j) => j.customerEmail?.trim().toLowerCase() === email) : [];

    const timeline: TimelineEntry[] = [];
    for (const n of noteViews) {
      if (n.body.startsWith(LEAD_FORM_NOTE_PREFIX)) {
        const detail = n.body.slice(LEAD_FORM_NOTE_PREFIX.length).trim();
        timeline.push({ kind: "lead_form", at: n.createdAt, title: "Web lead form", ...(detail ? { detail } : {}) });
      } else {
        timeline.push({ kind: "note", at: n.createdAt, title: "Note", detail: n.body });
      }
    }
    for (const d of mine) {
      timeline.push({ kind: "deal", at: d.createdAt, title: `Deal: ${d.name}`, detail: d.stage.replaceAll("_", " "), href: `/orgs/${input.orgId}/sales/deals/${d.id}` });
    }
    for (const r of external) {
      timeline.push({ kind: "external_deal", at: r.createdAt.toISOString(), title: `Synced deal: ${r.name}`, detail: `${r.provider} · ${r.stage}` });
    }
    for (const inv of invoiceRows) {
      timeline.push({ kind: "invoice", at: inv.createdAt.toISOString(), title: `Invoice ${inv.number ?? inv.id.slice(0, 8)} · ${inv.status}` });
    }
    for (const m of recentMessages) {
      timeline.push({
        kind: "message",
        at: m.sentAt.toISOString(),
        title: m.direction === "inbound" ? "Email received" : "Email sent",
        ...(m.subject ? { detail: m.subject } : {}),
        href: `/orgs/${input.orgId}/inbox/${m.conversationId}`,
      });
    }
    for (const j of jobs) {
      timeline.push({ kind: "job", at: j.createdAt, title: `Job · ${j.status.replaceAll("_", " ")}`, href: `/orgs/${input.orgId}/jobs/${j.id}` });
    }
    timeline.sort((a, b) => (a.at < b.at ? 1 : -1));

    const inboundMessageCount = recentMessages.filter((m) => m.direction === "inbound" && m.sender.trim().toLowerCase() === email).length;
    const score = scoreContact(
      { email: contact.email, phone: contact.phone, company: contact.company, source: contact.source },
      {
        hasOpenDeal: openDeals.length > 0,
        lastActivityAt: timeline[0]?.at ?? contact.updatedAt.toISOString(),
        inboundMessageCount,
      },
    );

    return { contact, score, notes: noteViews, openDeals, closedDeals, timeline: timeline.slice(0, 100) };
  });
}
