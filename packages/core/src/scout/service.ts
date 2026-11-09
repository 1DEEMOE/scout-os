import { and, desc, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  businessProfiles,
  communicationPermissions,
  contacts,
  intelligenceSources,
  opportunities,
  opportunityEvents,
  prospects,
  signalObservations,
  suppressionList,
  type ScoutSettings,
  type ServiceArea,
  type Tx,
} from "@wos/db";
import { recordAudit } from "../audit";
import { consumeQuota, requireFeature } from "../billing/plans";
import { AppError } from "../errors";
import { logger } from "../logger";
import { agents } from "@wos/db";
import { createAgent } from "../engine/agents";
import { SCOUT_PRESET } from "../engine/presets";
import { insertTask } from "../engine/tasks";
import { inOrg, MANAGERS, requireRole, STAFF } from "../org/access";
import { syncHandoffs } from "./lifecycle";
import { parseCsv, stripControl } from "./csv";
import { milesBetween, normCounty } from "./geo";
import { scoreMatch } from "./score";
import { parseSpcCsv, reportDayFromFilename, SPC_CONFIDENCE, SPC_LIMITATIONS, SPC_USAGE_RIGHTS } from "./spc";
import { vertical } from "./verticals";

export const SCOUT_DEFAULTS = { radiusMiles: 10, lookbackDays: 30, minScore: 30, retentionDays: 365 } as const;
export const MAX_UPLOAD_BYTES = 2_000_000;
export const MAX_IMPORT_ROWS = 5000;

type User = { actorUserId: string; orgId: string };

/** Role check, then the plan check. Non-members get NOT_FOUND before anything about plans. */
async function scoutAccess(tx: Tx, input: User, roles: readonly ("owner" | "admin" | "member" | "viewer")[], action: string) {
  await requireRole(tx, input.orgId, input.actorUserId, roles, action);
  await requireFeature(tx, input.orgId, "scout", { type: "user", id: input.actorUserId }, action);
}

export function settingsOf(s: ScoutSettings | null | undefined) {
  return { ...SCOUT_DEFAULTS, ...(s ?? {}) };
}

// ---------- business profile ----------

const stateCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
export const profileInput = z.object({
  vertical: z.literal("roofing"),
  website: z.string().trim().max(300).url().optional().or(z.literal("")),
  services: z.array(z.string().trim().min(1).max(80)).max(20),
  idealCustomer: z.string().trim().max(2000).default(""),
  serviceArea: z.object({
    states: z.array(stateCode).max(10),
    counties: z.array(z.object({ state: stateCode, county: z.string().trim().min(1).max(100) })).max(100),
    center: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).nullable(),
  }),
  settings: z.object({
    radiusMiles: z.number().int().min(1).max(50),
    lookbackDays: z.number().int().min(1).max(365),
    minScore: z.number().int().min(0).max(100),
    retentionDays: z.number().int().min(30).max(1095),
    monthlyDataCostCents: z.number().int().min(0).max(100_000_000),
    averageJobValueCents: z.number().int().min(0).max(100_000_000),
  }).partial().default({}),
});
export type ProfileInput = z.infer<typeof profileInput>;

export async function getBusinessProfile(input: User) {
  return inOrg(input.orgId, async (tx) => {
    await scoutAccess(tx, input, STAFF, "scout.profile.read");
    const [p] = await tx.select().from(businessProfiles);
    return p ?? null;
  });
}

/** Saving always puts the profile back to draft: a person must review it again before Scout scans. */
export async function saveBusinessProfile(input: User & { profile: unknown }) {
  return inOrg(input.orgId, async (tx) => {
    await scoutAccess(tx, input, MANAGERS, "scout.profile.save");
    const parsed = profileInput.safeParse(input.profile);
    if (!parsed.success) throw new AppError("VALIDATION", `Profile: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
    const p = parsed.data;
    if (!p.serviceArea.states.length && !p.serviceArea.counties.length) throw new AppError("VALIDATION", "Add at least one state or county you serve.");
    const values = {
      vertical: p.vertical,
      website: p.website || null,
      services: p.services,
      idealCustomer: p.idealCustomer,
      serviceArea: p.serviceArea as ServiceArea,
      settings: p.settings,
      status: "draft" as const,
      reviewedBy: null,
      reviewedAt: null,
      updatedBy: input.actorUserId,
      updatedAt: new Date(),
    };
    const [row] = await tx.insert(businessProfiles).values({ tenantId: input.orgId, ...values })
      .onConflictDoUpdate({ target: businessProfiles.tenantId, set: values }).returning();
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "scout.profile.save", target: `business_profile:${row!.id}`, tier: 1, outcome: "success" });
    return row!;
  });
}

/** Marks the profile reviewed and makes sure the org has its Scout agent. */
export async function reviewBusinessProfile(input: User) {
  const row = await inOrg(input.orgId, async (tx) => {
    await scoutAccess(tx, input, MANAGERS, "scout.profile.review");
    const [row] = await tx.update(businessProfiles).set({ status: "reviewed", reviewedBy: input.actorUserId, reviewedAt: new Date() }).returning();
    if (!row) throw new AppError("NOT_FOUND", "Save a business profile first.");
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "scout.profile.review", target: `business_profile:${row.id}`, tier: 1, outcome: "success" });
    return { row, hasAgent: (await tx.select({ id: agents.id }).from(agents).where(eq(agents.kind, "scout"))).length > 0 };
  });
  if (!row.hasAgent) await createAgent({ actorUserId: input.actorUserId, orgId: input.orgId, spec: SCOUT_PRESET });
  return row.row;
}

/** Queues a scan as an ordinary task for the Scout agent (worker, audit, retries, kill switch). */
export async function requestScan(input: User) {
  return inOrg(input.orgId, async (tx) => {
    await scoutAccess(tx, input, STAFF, "scout.scan.request");
    const [profile] = await tx.select({ status: businessProfiles.status }).from(businessProfiles);
    if (profile?.status !== "reviewed") throw new AppError("CONFLICT", "A manager needs to review the business profile before Scout can scan.");
    const [agent] = await tx.select({ id: agents.id, status: agents.status }).from(agents).where(eq(agents.kind, "scout"));
    if (!agent) throw new AppError("CONFLICT", "Scout isn't set up yet. A manager can review the business profile to set it up.");
    return insertTask(tx, {
      orgId: input.orgId, actorUserId: input.actorUserId, title: "Scout scan", intent: "Scan prospects against recent storm reports.",
      input: { agentKind: "scout" }, plan: { direct: [{ tool: "scout.scan", args: {} }] },
    });
  });
}

// ---------- storm reports ----------

export async function uploadStormReports(input: User & { csv: string; filename?: string; reportDay?: string; demo?: boolean }) {
  return inOrg(input.orgId, async (tx) => {
    await scoutAccess(tx, input, MANAGERS, "scout.signals.upload");
    if (input.csv.length > MAX_UPLOAD_BYTES) throw new AppError("VALIDATION", "That file is over 2 MB. Upload one day's report at a time.");
    const day = input.reportDay || reportDayFromFilename(input.filename ?? "");
    if (!day) throw new AppError("VALIDATION", "Which day is this report for? SPC files don't include the date, so enter it (YYYY-MM-DD).");
    let parsed;
    try {
      parsed = parseSpcCsv(input.csv, day);
    } catch {
      throw new AppError("VALIDATION", "The report day must be a real date in YYYY-MM-DD form.");
    }
    if (!parsed.signals.length) throw new AppError("VALIDATION", `No storm reports found in that file${parsed.rejected.length ? ` (${parsed.rejected.length} rows couldn't be read, first: line ${parsed.rejected[0]!.line}, ${parsed.rejected[0]!.reason})` : ""}.`);
    const [src] = await tx.insert(intelligenceSources).values({
      tenantId: input.orgId, kind: "noaa_spc_storm_reports", label: `SPC storm reports ${day}${input.demo ? " (DEMO)" : ""}`,
      usageRights: SPC_USAGE_RIGHTS, createdBy: input.actorUserId, demo: !!input.demo,
    }).returning({ id: intelligenceSources.id });
    const inserted = await tx.insert(signalObservations).values(parsed.signals.map((s) => ({
      tenantId: input.orgId, sourceId: src!.id, kind: s.kind, eventAt: s.eventAt, location: s.location, county: s.county, state: s.state,
      lat: s.lat, lon: s.lon, magnitude: s.magnitude, magnitudeUnit: s.magnitudeUnit, comments: s.comments,
      confidence: input.demo ? "Invented sample data (DEMO). Not a real storm report." : SPC_CONFIDENCE, limitations: SPC_LIMITATIONS, externalRef: s.externalRef, demo: !!input.demo,
    }))).onConflictDoNothing().returning({ id: signalObservations.id });
    await tx.update(intelligenceSources).set({ rowCount: inserted.length }).where(eq(intelligenceSources.id, src!.id));
    const result = { reportDay: day, added: inserted.length, duplicates: parsed.signals.length - inserted.length, rejected: parsed.rejected };
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "scout.signals.upload", target: `intelligence_source:${src!.id}`, tier: 1, outcome: "success", metadata: { reportDay: day, added: result.added, duplicates: result.duplicates, rejected: parsed.rejected.length } });
    return result;
  });
}

// ---------- prospect import ----------

/** The only columns ever stored. Anything else in the file is dropped and reported. */
const ALLOWED = ["name", "email", "phone", "address", "city", "county", "state", "postal_code", "lat", "lon", "kind"] as const;
type Col = (typeof ALLOWED)[number];
const HEADER_ALIASES: Record<string, Col> = { zip: "postal_code", zipcode: "postal_code", postcode: "postal_code", latitude: "lat", longitude: "lon", lng: "lon", full_name: "name", street: "address" };

const importInput = z.object({
  csv: z.string().min(1).max(MAX_UPLOAD_BYTES),
  label: z.string().trim().min(1).max(200),
  usageRights: z.string().trim().min(10, "Describe where this list came from and your right to use it (at least 10 characters).").max(2000),
  attest: z.literal(true, { message: "Confirm you have the right to use this list." }),
  demo: z.boolean().optional(),
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function importProspects(input: User & { csv: string; label: string; usageRights: string; attest: boolean; demo?: boolean }) {
  return inOrg(input.orgId, async (tx) => {
    await scoutAccess(tx, input, MANAGERS, "scout.prospects.import");

  const parsed = importInput.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]!.message);
  const rows = parseCsv(parsed.data.csv);
  if (rows.length < 2) throw new AppError("VALIDATION", "The file needs a header row and at least one prospect.");
  if (rows.length - 1 > MAX_IMPORT_ROWS) throw new AppError("VALIDATION", `Import up to ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows at a time.`);
  const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  const cols = header.map((h) => (ALLOWED as readonly string[]).includes(h) ? (h as Col) : HEADER_ALIASES[h] ?? null);
  const dropped = header.filter((_, i) => cols[i] === null);
  if (!cols.includes("name")) throw new AppError("VALIDATION", "The file needs a name column.");

  type Row = Partial<Record<Col, string>> & { line: number };
  const candidates: Row[] = [];
  const rejected: { line: number; reason: string }[] = [];
  rows.slice(1).forEach((r, i) => {
    const row: Row = { line: i + 2 };
    cols.forEach((c, j) => { if (c) row[c] = stripControl(r[j] ?? "").trim(); });
    if (!row.name) return void rejected.push({ line: row.line, reason: "no name" });
    if (row.email && !EMAIL.test(row.email)) return void rejected.push({ line: row.line, reason: "email isn't valid" });
    if (row.state && !/^[A-Za-z]{2}$/.test(row.state)) return void rejected.push({ line: row.line, reason: "state must be a 2-letter code" });
    const hasCoords = row.lat && row.lon && Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lon)) && Math.abs(Number(row.lat)) <= 90 && Math.abs(Number(row.lon)) <= 180;
    if ((row.lat || row.lon) && !hasCoords) return void rejected.push({ line: row.line, reason: "lat/lon aren't valid coordinates" });
    if (!hasCoords && !(row.county && row.state)) return void rejected.push({ line: row.line, reason: "needs lat/lon or county and state" });
    candidates.push(row);
  });

    const now = new Date();
    const [profile] = await tx.select({ settings: businessProfiles.settings }).from(businessProfiles);
    const retentionUntil = new Date(now.getTime() + settingsOf(profile?.settings).retentionDays * 86_400_000);
    const [src] = await tx.insert(intelligenceSources).values({
      tenantId: input.orgId, kind: "customer_import", label: parsed.data.label + (input.demo ? " (DEMO)" : ""), usageRights: parsed.data.usageRights,
      attestation: `${input.actorUserId} confirmed they have the right to use this list for contacting these people, as described.`,
      attestedBy: input.actorUserId, attestedAt: now, createdBy: input.actorUserId, demo: !!input.demo,
    }).returning({ id: intelligenceSources.id });

    const emails = candidates.map((c) => c.email?.toLowerCase()).filter((e): e is string => !!e);
    const known = emails.length ? await tx.select({ id: contacts.id, email: contacts.email }).from(contacts).where(inArray(sql`lower(${contacts.email})`, emails)) : [];
    const contactByEmail = new Map(known.map((k) => [k.email!.toLowerCase(), k.id]));

    const values = candidates.map((c) => {
      const email = c.email?.toLowerCase() || null;
      const dedupeKey = email ? `email:${email}` : `addr:${[c.name, c.address, c.postal_code, c.county, c.state].map((x) => (x ?? "").toLowerCase().replace(/\s+/g, " ").trim()).join("|")}`;
      const hasCoords = !!(c.lat && c.lon);
      return {
        tenantId: input.orgId, sourceId: src!.id, sourceRow: c.line, contactId: email ? contactByEmail.get(email) ?? null : null,
        kind: c.kind === "organization" ? ("organization" as const) : ("person" as const),
        name: c.name!.slice(0, 200), email, phone: c.phone?.slice(0, 40) || null, address: c.address?.slice(0, 300) || null,
        city: c.city?.slice(0, 100) || null, county: c.county?.slice(0, 100) || null, state: c.state?.toUpperCase() || null,
        postalCode: c.postal_code?.slice(0, 20) || null, lat: hasCoords ? Number(c.lat) : null, lon: hasCoords ? Number(c.lon) : null,
        dedupeKey: dedupeKey.slice(0, 300), retentionUntil, demo: !!input.demo,
      };
    });
    // Insert in batches: a single multi-row INSERT of 5,000 × ~18 columns exceeds
    // Postgres's 65,535 bind-parameter limit. Batches stay inside this transaction.
    const IMPORT_BATCH = 1000;
    const inserted: { id: string }[] = [];
    for (let i = 0; i < values.length; i += IMPORT_BATCH) {
      const chunk = values.slice(i, i + IMPORT_BATCH);
      const rows = await tx.insert(prospects).values(chunk).onConflictDoNothing().returning({ id: prospects.id });
      inserted.push(...rows);
    }
    // DEMO rows are for trying Scout and must not burn the plan's import quota.
    if (inserted.length && !input.demo) await consumeQuota(tx, input.orgId, "scout.prospect_rows", inserted.length);
    await tx.update(intelligenceSources).set({ rowCount: inserted.length }).where(eq(intelligenceSources.id, src!.id));
    const result = { added: inserted.length, duplicates: values.length - inserted.length, rejected, droppedColumns: dropped };
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "scout.prospects.import", target: `intelligence_source:${src!.id}`, tier: 1, outcome: "success",
      metadata: { added: result.added, duplicates: result.duplicates, rejected: rejected.length, droppedColumns: dropped } });
    return result;
  });
}

// ---------- scan: matching + scoring ----------

export interface ScanResult {
  examined: number;
  created: number;
  updated: number;
  belowMinScore: number;
  stoppedByQuota: boolean;
  purged: number;
}

/**
 * Matches prospects in the reviewed service area against recent storm reports
 * and scores them. Deterministic code; no model involved. Runs inside the
 * caller's tenant transaction (the scout.scan tool). The caller checks the plan.
 */
export async function runScoutScan(tx: Tx, tenantId: string, actor: { type: "agent" | "user" | "system"; id: string }, now = new Date()): Promise<ScanResult> {
  const [profile] = await tx.select().from(businessProfiles);
  if (!profile || profile.status !== "reviewed") throw new AppError("CONFLICT", "A person needs to review the business profile before Scout can scan.");
  const v = vertical(profile.vertical);
  const cfg = settingsOf(profile.settings);
  const area = profile.serviceArea;
  const purged = await purgeExpiredProspects(tx, tenantId, now);
  await syncHandoffs(tx, tenantId);

  const since = new Date(now.getTime() - cfg.lookbackDays * 86_400_000);
  const signals = await tx.select().from(signalObservations)
    .where(and(sql`${signalObservations.eventAt} >= ${since}`, sql`${signalObservations.eventAt} <= ${now}`, inArray(signalObservations.kind, [...v.signalKinds])));
  const states = new Set(area.states.map((s) => s.toUpperCase()));
  const counties = new Set(area.counties.map((c) => `${c.state.toUpperCase()}|${normCounty(c.county)}`));
  const inArea = (state: string | null, county: string | null) => !!state && (states.has(state) || counties.has(`${state}|${normCounty(county)}`));

  const all = await tx.select().from(prospects);
  const candidates = all.filter((p) => inArea(p.state, p.county));
  const open = await tx.select({ id: opportunities.id, prospectId: opportunities.prospectId, stage: opportunities.stage }).from(opportunities).where(sql`${opportunities.stage} <> 'disqualified'`);
  const openByProspect = new Map(open.map((o) => [o.prospectId, o]));
  const disq = new Set((await tx.select({ p: opportunities.prospectId }).from(opportunities).where(eq(opportunities.stage, "disqualified"))).map((r) => r.p));
  const emails = candidates.map((p) => p.email).filter((e): e is string => !!e);
  const permitted = new Set(emails.length ? (await tx.select({ v: communicationPermissions.value }).from(communicationPermissions)
    .where(and(eq(communicationPermissions.channel, "email"), isNull(communicationPermissions.revokedAt), inArray(communicationPermissions.value, emails)))).map((r) => r.v) : []);
  const suppressed = new Set(emails.length ? (await tx.select({ v: suppressionList.value }).from(suppressionList).where(inArray(suppressionList.value, emails))).map((r) => r.v) : []);
  const sourceKind = new Map((await tx.select({ id: intelligenceSources.id, kind: intelligenceSources.kind }).from(intelligenceSources)).map((s) => [s.id, s.kind]));

  const result: ScanResult = { examined: candidates.length, created: 0, updated: 0, belowMinScore: 0, stoppedByQuota: false, purged };
  for (const p of candidates) {
    if (disq.has(p.id) && !openByProspect.has(p.id)) continue; // a person ruled them out; don't resurface
    const matches = signals.flatMap((s) => {
      if (p.lat !== null && p.lon !== null && s.lat !== null && s.lon !== null) {
        const d = milesBetween({ lat: p.lat, lon: p.lon }, { lat: s.lat, lon: s.lon });
        return d <= cfg.radiusMiles ? [{ s, d }] : [];
      }
      return s.state === p.state && normCounty(s.county) === normCounty(p.county) ? [{ s, d: null as number | null }] : [];
    });
    if (!matches.length) continue;
    const engaged = (p.email ? permitted.has(p.email) : false) || (openByProspect.get(p.id)?.stage ?? "prospect") !== "prospect";
    const reliability = p.contactId ? "crm_contact" as const : p.lat !== null ? "import_with_coordinates" as const : "import_county_only" as const;
    const scored = matches.map((m) => ({ ...m, ...scoreMatch(v, {
      signal: { kind: m.s.kind, magnitude: m.s.magnitude === null ? null : Number(m.s.magnitude), magnitudeUnit: m.s.magnitudeUnit, eventAt: m.s.eventAt },
      distanceMiles: m.d, reliability, engaged, now,
    }) })).sort((a, b) => b.score - a.score || +b.s.eventAt - +a.s.eventAt);
    const best = scored[0]!;
    if (best.score < cfg.minScore) { result.belowMinScore++; continue; }
    const evidence = scored.slice(0, 10).map((m) => ({
      signalId: m.s.id, kind: m.s.kind, description: v.describeSignal({ kind: m.s.kind, magnitude: m.s.magnitude === null ? null : Number(m.s.magnitude), magnitudeUnit: m.s.magnitudeUnit }),
      place: `${m.s.location}, ${m.s.county} County, ${m.s.state}`, distanceMiles: m.d === null ? null : Math.round(m.d * 10) / 10,
      eventAt: m.s.eventAt.toISOString(), source: m.s.demo ? "invented sample storm report (DEMO), not real weather data" : "NOAA SPC local storm report", confidence: m.s.confidence, demo: m.s.demo,
    }));
    const canEmail = !!p.email && permitted.has(p.email) && !suppressed.has(p.email);
    const missing = [
      "No information about damage to this property (none is collected).",
      ...(!p.email ? ["No email address."] : []),
      ...(p.email && suppressed.has(p.email) ? ["On your do-not-contact list."] : []),
      ...(p.email && !permitted.has(p.email) ? ["No recorded permission to contact them."] : []),
      ...(best.d === null ? ["No exact location; matched by county."] : []),
    ];
    const srcKind = sourceKind.get(p.sourceId);
    const explanation = {
      whyIdentified: `${p.name} is in ${srcKind === "customer_import" ? "a list you imported" : "your records"}${p.sourceRow ? ` (row ${p.sourceRow})` : ""}, located in ${p.county ? `${p.county}, ` : ""}${p.state}, inside your reviewed service area.`,
      whyRelevant: `${evidence[0]!.description[0]!.toUpperCase()}${evidence[0]!.description.slice(1)} was made ${best.d === null ? "in the same county" : `${evidence[0]!.distanceMiles} ${evidence[0]!.distanceMiles === 1 ? "mile" : "miles"} away`}. ${v.whyRelevant}`,
      evidence,
      missingInformation: missing,
      recommendedAction: suppressed.has(p.email ?? "")
        ? "Don't contact: they're on your do-not-contact list."
        : canEmail
          ? "Follow up by email on your existing conversation and offer an inspection. Sending still needs approval."
          : "Don't contact yet. There's no recorded permission. If they reach out, or you have an existing relationship, record it first.",
      confidenceBasis: `Heuristic score from fixed rules, not a probability. ${v.limitations}`,
    };
    const existing = openByProspect.get(p.id);
    if (existing) {
      await tx.update(opportunities).set({ score: best.score, scoreBreakdown: best.breakdown as unknown as Record<string, unknown>, explanation, signalIds: evidence.map((e) => e.signalId), updatedAt: now }).where(eq(opportunities.id, existing.id));
      result.updated++;
      continue;
    }
    try {
      await consumeQuota(tx, tenantId, "scout.opportunities", 1);
    } catch (e) {
      if (e instanceof AppError && e.code === "QUOTA_EXCEEDED") { result.stoppedByQuota = true; break; }
      throw e;
    }
    const [opp] = await tx.insert(opportunities).values({
      tenantId, prospectId: p.id, vertical: v.id, stage: "prospect", score: best.score, scoreBreakdown: best.breakdown as unknown as Record<string, unknown>,
      explanation, signalIds: evidence.map((e) => e.signalId), demo: p.demo,
    }).returning({ id: opportunities.id });
    await tx.insert(opportunityEvents).values({ tenantId, opportunityId: opp!.id, fromStage: null, toStage: "prospect", actorType: actor.type, actorId: actor.id, evidence: `Matched to ${evidence.length} storm report${evidence.length === 1 ? "" : "s"}; heuristic score ${best.score}.` });
    result.created++;
  }
  await recordAudit(tx, { tenantId, actorType: actor.type, actorId: actor.id, action: "scout.scan", tier: 1, outcome: "success", metadata: { ...result } });
  logger.info({ tenantId, ...result }, "scout scan");
  return result;
}

/**
 * Deletes prospects past their retention date, unless a person moved them past
 * "prospect" (qualified/handed off records are business records now). Audited.
 */
export async function purgeExpiredProspects(tx: Tx, tenantId: string, now = new Date()): Promise<number> {
  const keep = tx.select({ p: opportunities.prospectId }).from(opportunities).where(inArray(opportunities.stage, ["engaged", "qualified", "opportunity"]));
  const gone = await tx.delete(prospects).where(and(lt(prospects.retentionUntil, now), notInArray(prospects.id, keep))).returning({ id: prospects.id });
  if (gone.length) await recordAudit(tx, { tenantId, actorType: "system", actorId: "retention", action: "scout.prospects.purge", tier: 1, outcome: "success", metadata: { deleted: gone.length } });
  return gone.length;
}

// ---------- reads ----------

export async function listOpportunities(input: User & { stage?: string; limit?: number }) {
  return inOrg(input.orgId, async (tx) => {
    await scoutAccess(tx, input, STAFF, "scout.opportunities.read");
    await syncHandoffs(tx, input.orgId);
    const rows = await tx.select({ o: opportunities, p: prospects }).from(opportunities)
      .innerJoin(prospects, and(eq(prospects.tenantId, opportunities.tenantId), eq(prospects.id, opportunities.prospectId)))
      .where(input.stage ? eq(opportunities.stage, input.stage as "prospect") : undefined)
      .orderBy(desc(opportunities.score), desc(opportunities.updatedAt)).limit(Math.min(input.limit ?? 100, 500));
    return rows.map(({ o, p }) => ({ ...o, prospect: { id: p.id, name: p.name, email: p.email, phone: p.phone, address: p.address, city: p.city, county: p.county, state: p.state, demo: p.demo, contactId: p.contactId } }));
  });
}

export async function listSignals(input: User & { kind?: string; state?: string; limit?: number }) {
  return inOrg(input.orgId, async (tx) => {
    await scoutAccess(tx, input, STAFF, "scout.signals.read");
    const conds = [
      input.kind ? eq(signalObservations.kind, input.kind as "hail") : undefined,
      input.state ? eq(signalObservations.state, input.state.toUpperCase()) : undefined,
    ].filter(Boolean);
    return tx.select().from(signalObservations).where(conds.length ? and(...conds) : undefined).orderBy(desc(signalObservations.eventAt)).limit(Math.min(input.limit ?? 200, 1000));
  });
}

export async function listSources(input: User) {
  return inOrg(input.orgId, async (tx) => {
    await scoutAccess(tx, input, STAFF, "scout.sources.read");
    return tx.select().from(intelligenceSources).orderBy(desc(intelligenceSources.createdAt)).limit(100);
  });
}
