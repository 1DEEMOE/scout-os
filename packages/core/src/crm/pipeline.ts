/**
 * Native deal pipeline — the core CRM loop (board, stages, weighted forecast)
 * running on our own records instead of a synced mirror of HubSpot.
 *
 * Persistence is interim: deals live in memory_records (layer "org", scopeRef
 * `deal:<id>`, pipeline weights at scopeRef `pipeline-config`) until proposed
 * migration 0027_crm_pipeline.sql is reviewed and applied — the same interim
 * pattern as jobs (0026). The forecast is computed on read from the same rows
 * the board renders, so the two can never disagree. Deals are never deleted:
 * a deal is a financial-adjacent record, and closing one keeps it auditable.
 *
 * Probabilities are basis points (0–10000 = 0–100%). Defaults are simple and
 * explainable; owners can tune open-stage weights, but won is always 100% and
 * lost is always 0%.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, like } from "drizzle-orm";
import { contacts, memoryRecords, organizationMembers, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { ANY_ROLE, inOrg, MANAGERS, requireRole, STAFF } from "../org/access";

const REF_PREFIX = "deal:";
const CONFIG_REF = "pipeline-config";
/** memory_records content cap (see jobs/service.ts). */
const CONTENT_CAP = 2000;

export const OPEN_STAGES = ["lead", "qualified", "quote_sent", "negotiation"] as const;
export type OpenStage = (typeof OPEN_STAGES)[number];
/** Native stages, including the two closed outcomes. (tools/crm.ts already owns DEAL_STAGES for the HubSpot mirror.) */
export const NATIVE_DEAL_STAGES = [...OPEN_STAGES, "won", "lost"] as const;
export type DealStage = (typeof NATIVE_DEAL_STAGES)[number];

export const DEAL_SOURCES = ["manual", "web_form", "inbox", "job", "import"] as const;
export type DealSource = (typeof DEAL_SOURCES)[number];

/** Basis points per stage (10000 = 100%). Won/lost are facts, not config. */
export const DEFAULT_PROBABILITY_BPS: Record<DealStage, number> = {
  lead: 1000,
  qualified: 2500,
  quote_sent: 5000,
  negotiation: 7500,
  won: 10000,
  lost: 0,
};

export interface DealRecord {
  v: 1;
  id: string;
  tenantId: string;
  contactId: string | null;
  name: string;
  amountCents: number | null;
  stage: DealStage;
  source: DealSource;
  /** YYYY-MM-DD, no timezone games. */
  expectedClose: string | null;
  ownerUserId: string | null;
  lostReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/** Per-org tuning of open-stage probabilities. */
export interface PipelineConfig {
  v: 1;
  probabilityBps: Partial<Record<OpenStage, number>>;
}

const DEFAULT_CONFIG: PipelineConfig = { v: 1, probabilityBps: {} };

export class DealTransitionError extends AppError {
  constructor(from: DealStage, to: DealStage) {
    super("CONFLICT", `A deal cannot move from "${from}" to "${to}".`);
  }
}

/* ------------------------------------------------------------- cleaners */

function cleanName(v: unknown): string {
  const name = String(v ?? "").trim().slice(0, 120);
  if (!name) throw new AppError("VALIDATION", "Deal name is required");
  return name;
}

function cleanAmount(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000_000) throw new AppError("VALIDATION", "Amount must be a whole number of cents between 0 and 100,000,000");
  return n;
}

function cleanExpectedClose(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new AppError("VALIDATION", "Expected close must be a date (YYYY-MM-DD)");
  return s;
}

/** The contact must belong to this tenant (the read is RLS-scoped). */
async function cleanContact(tx: Tx, v: unknown): Promise<string | null> {
  if (v === null || v === undefined || v === "") return null;
  const id = String(v);
  const [row] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, id));
  if (!row) throw new AppError("VALIDATION", "That contact does not exist in this workspace");
  return row.id;
}

/** The owner must be a member of this tenant. */
async function cleanOwner(tx: Tx, tenantId: string, v: unknown): Promise<string | null> {
  if (v === null || v === undefined || v === "") return null;
  const id = String(v);
  const [row] = await tx
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.tenantId, tenantId), eq(organizationMembers.userId, id)));
  if (!row) throw new AppError("VALIDATION", "The deal owner must be a member of this workspace");
  return row.userId;
}

/* ------------------------------------------------------------- storage */

function parseDeal(content: string): DealRecord | null {
  try {
    const v = JSON.parse(content) as DealRecord;
    return v && v.v === 1 && typeof v.id === "string" && typeof v.tenantId === "string" && typeof v.stage === "string" ? v : null;
  } catch {
    return null;
  }
}

async function putDeal(tx: Tx, deal: DealRecord): Promise<void> {
  const content = JSON.stringify(deal);
  if (content.length > CONTENT_CAP) {
    throw new AppError("VALIDATION", "This deal has grown past what the interim store can hold.");
  }
  const ref = REF_PREFIX + deal.id;
  await tx.delete(memoryRecords).where(and(eq(memoryRecords.tenantId, deal.tenantId), eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, ref)));
  await tx.insert(memoryRecords).values({ tenantId: deal.tenantId, layer: "org", scopeRef: ref, content, trust: "verified", createdByUser: deal.createdBy });
}

/** Read inside an RLS-scoped tx — another org's deals are invisible by construction. */
export async function readDealTx(tx: Tx, tenantId: string, dealId: string): Promise<DealRecord> {
  const rows = await tx
    .select({ content: memoryRecords.content })
    .from(memoryRecords)
    .where(and(eq(memoryRecords.tenantId, tenantId), eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, REF_PREFIX + dealId)))
    .orderBy(desc(memoryRecords.createdAt))
    .limit(1);
  const deal = rows[0] ? parseDeal(rows[0].content) : null;
  if (!deal) throw new AppError("NOT_FOUND", "Deal not found");
  return deal;
}

/** All deals in the tenant, newest first. Storage-level: no role check, no audit. */
export async function listDealsTx(tx: Tx, tenantId: string): Promise<DealRecord[]> {
  const rows = await tx
    .select({ content: memoryRecords.content })
    .from(memoryRecords)
    .where(and(eq(memoryRecords.tenantId, tenantId), eq(memoryRecords.layer, "org"), like(memoryRecords.scopeRef, `${REF_PREFIX}%`)))
    .orderBy(desc(memoryRecords.createdAt))
    .limit(500);
  return rows.map((r) => parseDeal(r.content)).filter((d): d is DealRecord => d !== null);
}

function parseConfig(content: string): PipelineConfig | null {
  try {
    const v = JSON.parse(content) as PipelineConfig;
    return v && v.v === 1 && typeof v.probabilityBps === "object" && v.probabilityBps !== null ? v : null;
  } catch {
    return null;
  }
}

export async function readPipelineConfigTx(tx: Tx, tenantId: string): Promise<PipelineConfig> {
  const rows = await tx
    .select({ content: memoryRecords.content })
    .from(memoryRecords)
    .where(and(eq(memoryRecords.tenantId, tenantId), eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, CONFIG_REF)))
    .orderBy(desc(memoryRecords.createdAt))
    .limit(1);
  return (rows[0] && parseConfig(rows[0].content)) || { v: 1, probabilityBps: { ...DEFAULT_CONFIG.probabilityBps } };
}

/** Probability for a stage in basis points: org tuning for open stages, facts for closed ones. */
export function probabilityFor(config: PipelineConfig, stage: DealStage): number {
  if (stage === "won") return DEFAULT_PROBABILITY_BPS.won;
  if (stage === "lost") return DEFAULT_PROBABILITY_BPS.lost;
  const tuned = config.probabilityBps[stage];
  return tuned ?? DEFAULT_PROBABILITY_BPS[stage];
}

/* -------------------------------------------------------------- queries */

export type DealView = DealRecord & {
  contactName: string | null;
  contactEmail: string | null;
  probabilityBps: number;
  weightedCents: number | null;
};

function toView(deal: DealRecord, config: PipelineConfig, contact?: { name: string; email: string | null } | null): DealView {
  const probabilityBps = probabilityFor(config, deal.stage);
  return {
    ...deal,
    contactName: contact?.name ?? null,
    contactEmail: contact?.email ?? null,
    probabilityBps,
    weightedCents: deal.amountCents === null ? null : Math.round((deal.amountCents * probabilityBps) / 10_000),
  };
}

export async function listPipeline(input: { actorUserId: string; orgId: string; stage?: DealStage }): Promise<DealView[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "crm.pipeline.list");
    const config = await readPipelineConfigTx(tx, input.orgId);
    const deals = await listDealsTx(tx, input.orgId);
    const contactIds = [...new Set(deals.map((d) => d.contactId).filter((c): c is string => c !== null))];
    const names = new Map<string, { name: string; email: string | null }>();
    for (const id of contactIds) {
      const [c] = await tx.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts).where(eq(contacts.id, id));
      if (c) names.set(c.id, { name: c.name, email: c.email });
    }
    return deals.filter((d) => !input.stage || d.stage === input.stage).map((d) => toView(d, config, d.contactId ? names.get(d.contactId) : null));
  });
}

export async function getDeal(input: { actorUserId: string; orgId: string; dealId: string }): Promise<DealView> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "crm.deal.read");
    const config = await readPipelineConfigTx(tx, input.orgId);
    const deal = await readDealTx(tx, input.orgId, input.dealId);
    let contact: { name: string; email: string | null } | null = null;
    if (deal.contactId) {
      const [c] = await tx.select({ name: contacts.name, email: contacts.email }).from(contacts).where(eq(contacts.id, deal.contactId));
      contact = c ?? null;
    }
    return toView(deal, config, contact);
  });
}

export interface PipelineForecast {
  month: string;
  stages: { stage: OpenStage; count: number; totalCents: number; weightedCents: number }[];
  open: { count: number; totalCents: number; weightedCents: number };
  wonThisMonth: { count: number; totalCents: number };
  lostThisMonth: { count: number; totalCents: number };
}

/**
 * Weighted forecast for a month (YYYY-MM, default: this month). Computed on
 * read from the same deals the board shows — the forecast cannot drift from
 * the pipeline because it IS the pipeline.
 */
export async function pipelineForecast(input: { actorUserId: string; orgId: string; month?: string }): Promise<PipelineForecast> {
  const month = input.month ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError("VALIDATION", "Month must be YYYY-MM");
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "crm.pipeline.forecast");
    const config = await readPipelineConfigTx(tx, input.orgId);
    const deals = await listDealsTx(tx, input.orgId);

    const stages = OPEN_STAGES.map((stage) => {
      const inStage = deals.filter((d) => d.stage === stage);
      const totalCents = inStage.reduce((s, d) => s + (d.amountCents ?? 0), 0);
      const weightedCents = inStage.reduce((s, d) => s + (d.amountCents === null ? 0 : Math.round((d.amountCents * probabilityFor(config, d.stage)) / 10_000)), 0);
      return { stage, count: inStage.length, totalCents, weightedCents };
    });
    const openDeals = deals.filter((d) => (OPEN_STAGES as readonly string[]).includes(d.stage));
    const closedThisMonth = deals.filter((d) => d.closedAt && d.closedAt.slice(0, 7) === month);
    const won = closedThisMonth.filter((d) => d.stage === "won");
    const lost = closedThisMonth.filter((d) => d.stage === "lost");
    return {
      month,
      stages,
      open: {
        count: openDeals.length,
        totalCents: openDeals.reduce((s, d) => s + (d.amountCents ?? 0), 0),
        weightedCents: openDeals.reduce((s, d) => s + (d.amountCents === null ? 0 : Math.round((d.amountCents * probabilityFor(config, d.stage)) / 10_000)), 0),
      },
      wonThisMonth: { count: won.length, totalCents: won.reduce((s, d) => s + (d.amountCents ?? 0), 0) },
      lostThisMonth: { count: lost.length, totalCents: lost.reduce((s, d) => s + (d.amountCents ?? 0), 0) },
    };
  });
}

/* ------------------------------------------------------------ mutations */

/**
 * Storage-level insert with no role check or audit — for system paths like
 * the public lead form, whose caller is not a workspace member and which
 * writes its own system audit row. Interactive callers use createDeal.
 */
export async function insertDealTx(
  tx: Tx,
  input: {
    tenantId: string;
    contactId: string | null;
    name: string;
    amountCents: number | null;
    stage: OpenStage;
    source: DealSource;
    expectedClose?: string | null;
    ownerUserId?: string | null;
    createdBy: string;
  },
): Promise<DealRecord> {
  const now = new Date().toISOString();
  const deal: DealRecord = {
    v: 1,
    id: randomUUID(),
    tenantId: input.tenantId,
    contactId: input.contactId,
    name: input.name,
    amountCents: input.amountCents,
    stage: input.stage,
    source: input.source,
    expectedClose: input.expectedClose ?? null,
    ownerUserId: input.ownerUserId ?? null,
    lostReason: null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  await putDeal(tx, deal);
  return deal;
}

export async function createDeal(input: {
  actorUserId: string;
  orgId: string;
  contactId?: string | null;
  name: string;
  amountCents?: number | null;
  stage?: OpenStage;
  expectedClose?: string | null;
  ownerUserId?: string | null;
}): Promise<{ dealId: string }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "crm.deal.create");
    const stage = input.stage ?? "lead";
    if (!(OPEN_STAGES as readonly string[]).includes(stage)) {
      throw new AppError("VALIDATION", "A new deal must start in an open stage");
    }
    const deal = await insertDealTx(tx, {
      tenantId: input.orgId,
      contactId: await cleanContact(tx, input.contactId),
      name: cleanName(input.name),
      amountCents: cleanAmount(input.amountCents),
      stage,
      source: "manual",
      expectedClose: cleanExpectedClose(input.expectedClose),
      ownerUserId: await cleanOwner(tx, input.orgId, input.ownerUserId),
      createdBy: input.actorUserId,
    });
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "crm.deal.create",
      target: `deal:${deal.id}`,
      tier: 0,
      outcome: "success",
      metadata: { stage: deal.stage, hasAmount: deal.amountCents !== null },
    });
    return { dealId: deal.id };
  });
}

export async function updateDeal(input: {
  actorUserId: string;
  orgId: string;
  dealId: string;
  name?: string;
  amountCents?: number | null;
  expectedClose?: string | null;
  ownerUserId?: string | null;
  contactId?: string | null;
}): Promise<{ dealId: string }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "crm.deal.update");
    const deal = await readDealTx(tx, input.orgId, input.dealId);
    if (deal.stage === "won" || deal.stage === "lost") {
      throw new AppError("CONFLICT", `This deal is ${deal.stage}. Reopen it before editing.`);
    }
    const next: DealRecord = { ...deal, updatedAt: new Date().toISOString() };
    if (input.name !== undefined) next.name = cleanName(input.name);
    if (input.amountCents !== undefined) next.amountCents = cleanAmount(input.amountCents);
    if (input.expectedClose !== undefined) next.expectedClose = cleanExpectedClose(input.expectedClose);
    if (input.ownerUserId !== undefined) next.ownerUserId = await cleanOwner(tx, input.orgId, input.ownerUserId);
    if (input.contactId !== undefined) next.contactId = await cleanContact(tx, input.contactId);
    await putDeal(tx, next);
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "crm.deal.update",
      target: `deal:${deal.id}`,
      tier: 0,
      outcome: "success",
      metadata: { fields: Object.keys(input).filter((k) => !["actorUserId", "orgId", "dealId"].includes(k)).sort() },
    });
    return { dealId: deal.id };
  });
}

/**
 * Moves a deal between stages. Any staff member advances open deals; closing
 * (won/lost) is also staff, but REOPENING a closed deal is manager-only.
 * won ↔ lost directly is never allowed: reopen to an open stage first.
 * Moving to the current stage is an idempotent no-op.
 */
export async function moveDeal(input: {
  actorUserId: string;
  orgId: string;
  dealId: string;
  stage: DealStage;
  lostReason?: string | null;
}): Promise<{ stage: DealStage }> {
  return inOrg(input.orgId, async (tx) => {
    // Role gate BEFORE the read: a non-member must not be able to probe deal ids.
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "crm.deal.move");
    const deal = await readDealTx(tx, input.orgId, input.dealId);
    const from = deal.stage;
    const to = input.stage;
    if (!(NATIVE_DEAL_STAGES as readonly string[]).includes(to)) throw new AppError("VALIDATION", "Unknown stage");

    const wasClosed = from === "won" || from === "lost";
    const willBeOpen = (OPEN_STAGES as readonly string[]).includes(to);
    if (wasClosed && willBeOpen) {
      // Reopening history is a manager call.
      await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "crm.deal.reopen");
    }
    if (wasClosed && !willBeOpen && from !== to) throw new DealTransitionError(from, to);

    if (from === to) return { stage: from }; // idempotent retry

    const now = new Date().toISOString();
    const closing = to === "won" || to === "lost";
    const next: DealRecord = {
      ...deal,
      stage: to,
      updatedAt: now,
      closedAt: closing ? now : null,
      // A lost deal keeps its reason; anything else clears it.
      lostReason: to === "lost" ? (input.lostReason?.trim().slice(0, 200) || null) : null,
    };
    await putDeal(tx, next);
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: closing ? `crm.deal.${to}` : "crm.deal.move",
      target: `deal:${deal.id}`,
      tier: 0,
      outcome: "success",
      metadata: { from, to, ...(to === "lost" ? { hasReason: next.lostReason !== null } : {}) },
    });
    return { stage: to };
  });
}

/** Owner/admin tunes open-stage probabilities. Unknown stages and out-of-range weights are rejected. */
export async function savePipelineConfig(input: {
  actorUserId: string;
  orgId: string;
  probabilityBps: Partial<Record<OpenStage, number>>;
}): Promise<{ saved: true }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "crm.pipeline.config");
    for (const [stage, bps] of Object.entries(input.probabilityBps)) {
      if (!(OPEN_STAGES as readonly string[]).includes(stage)) {
        throw new AppError("VALIDATION", `Unknown pipeline stage "${stage}". Only open stages can be tuned.`);
      }
      if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
        throw new AppError("VALIDATION", "Probabilities must be whole basis points between 0 and 10000");
      }
    }
    const current = await readPipelineConfigTx(tx, input.orgId);
    const next: PipelineConfig = { v: 1, probabilityBps: { ...current.probabilityBps, ...input.probabilityBps } };
    const content = JSON.stringify(next);
    if (content.length > CONTENT_CAP) throw new AppError("VALIDATION", "Pipeline config is too large to store.");
    await tx.delete(memoryRecords).where(and(eq(memoryRecords.tenantId, input.orgId), eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, CONFIG_REF)));
    await tx.insert(memoryRecords).values({ tenantId: input.orgId, layer: "org", scopeRef: CONFIG_REF, content, trust: "verified", createdByUser: input.actorUserId });
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "crm.pipeline.config",
      target: "pipeline-config",
      tier: 1,
      outcome: "success",
      metadata: { stages: Object.keys(input.probabilityBps).sort() },
    });
    return { saved: true };
  });
}
