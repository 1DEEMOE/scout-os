/**
 * Opportunity finder: pulls public signals (storm reports, building permits)
 * through adapters for the reviewed service area, turns old-roof permits near
 * fresh storm damage into prospects, scores them with Scout's existing rules,
 * and drafts a first outreach message that only an owner can approve.
 *
 * Today every adapter is MOCK, so everything it creates is demo=true and
 * labelled; "Remove sample data" clears it. Nothing is sent from here: the
 * message becomes a tier-2, owner-only approval, and consent plus the
 * do-not-contact list are checked again at send time.
 */
import { and, eq, inArray } from "drizzle-orm";
import { agents, approvalRequests, opportunities, organizations, prospects, signalObservations, tasks, withTenant } from "@wos/db";
import { recordAudit } from "../audit";
import { SCOUT_OUTREACH_TOOL } from "../engine/owner-only";
import { randomUUID } from "node:crypto";
import { consumeQuota } from "../billing/plans";
import { actionDigest } from "../engine/digest";
import { AppError } from "../errors";
import { inOrg, MANAGERS, requireRole, STAFF } from "../org/access";
import { requireFeature } from "../billing/plans";
import { checkEmailAllowed } from "../scout/consent";
import { getBusinessProfile, importProspects, runScoutScan, uploadStormReports } from "../scout/service";
import { mockPermitAdapter, mockStormAdapter, type Area, type PermitRecord, type StormReport } from "./adapters";

type Actor = { actorUserId: string; orgId: string };

/** Roofs re-done this long ago are likely due; recent permits mean someone already has the job. */
export const OLD_ROOF_YEARS = 15;
export const RECENT_PERMIT_DAYS = 60;

export interface FinderSource {
  id: string;
  label: string;
  kind: "storm" | "permit";
  mock: boolean;
  records: number;
  used: number;
  note: string;
}

export interface FinderResult {
  sources: FinderSource[];
  prospectsAdded: number;
  opportunities: number;
  skippedRecentPermits: number;
}

function spcCsv(reports: StormReport[]): string {
  const row = (s: StormReport) => [s.timeUtc, s.magnitude ?? "UNK", s.location, s.county, s.state, s.lat, s.lon, s.comments.replace(/,/g, ";")].join(",");
  const out: string[] = [];
  const section = (head: string, kind: StormReport["kind"]) => {
    const rows = reports.filter((r) => r.kind === kind);
    if (rows.length) out.push(`Time,${head},Location,County,State,Lat,Lon,Comments`, ...rows.map(row));
  };
  section("F_Scale", "tornado");
  section("Speed", "wind");
  section("Size", "hail");
  return out.join("\n");
}

export function pickPermitLeads(permits: PermitRecord[], now: Date): { leads: PermitRecord[]; skippedRecent: number } {
  const ageYears = (p: PermitRecord) => (now.getTime() - Date.parse(p.issuedOn)) / (365.25 * 86_400_000);
  const recent = permits.filter((p) => (now.getTime() - Date.parse(p.issuedOn)) / 86_400_000 <= RECENT_PERMIT_DAYS);
  return { leads: permits.filter((p) => ageYears(p) >= OLD_ROOF_YEARS), skippedRecent: recent.length };
}

/** Runs every adapter for the service area and scores what it finds. Managers only; Scout plan feature. */
export async function runOpportunityFinder(input: Actor & { now?: Date }): Promise<FinderResult> {
  const now = input.now ?? new Date();
  const profile = await getBusinessProfile(input);
  const counties = ((profile?.serviceArea as { counties?: Area[] } | undefined)?.counties ?? []).slice(0, 5);
  if (!profile || profile.status !== "reviewed" || !counties.length) {
    throw new AppError("CONFLICT", "Set and review your service area in Scout setup first, so the finder knows where to look.");
  }
  const day = new Date(now.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
  let storms: StormReport[] = [];
  let permits: PermitRecord[] = [];
  for (const area of counties) {
    storms = storms.concat(await mockStormAdapter.fetch(area, { day, now }));
    permits = permits.concat(await mockPermitAdapter.fetch(area, { day, now }));
  }
  const { leads, skippedRecent } = pickPermitLeads(permits, now);

  if (storms.length) await uploadStormReports({ ...input, csv: spcCsv(storms), reportDay: day, demo: true }).catch((err: unknown) => {
    // Re-running the same day is fine: the reports are already stored.
    if (!(err instanceof AppError && /duplicate|already/i.test(err.message))) throw err;
  });
  let prospectsAdded = 0;
  if (leads.length) {
    const csv = [
      "name,email,address,city,county,state,zip,lat,lon",
      ...leads.map((p) => [`${p.ownerName} (DEMO)`, p.ownerEmail ?? "", p.address, p.city, p.county, p.state, p.zip, p.lat, p.lon].join(",")),
    ].join("\n");
    const imported = (await importProspects({
      ...input,
      csv,
      label: "Building permits: roofs 15+ years old (MOCK feed)",
      usageRights: "Invented sample records from a MOCK building-permit feed, for trying the finder. Not real people. Domains are example.test.",
      attest: true,
      demo: true,
    })) as { added?: number };
    prospectsAdded = Number(imported.added ?? 0);
  }
  const scan = await withTenant(input.orgId, (tx) => runScoutScan(tx, input.orgId, { type: "user", id: input.actorUserId }, now));
  const openOpps = await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "finder.run");
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "finder.run",
      target: `organization:${input.orgId}`,
      tier: 1,
      outcome: "success",
      metadata: { adapters: [mockStormAdapter.id, mockPermitAdapter.id], mock: true, storms: storms.length, permits: permits.length, leads: leads.length, prospectsAdded, scan: scan as unknown as Record<string, unknown> },
    });
    const rows = await tx.select({ id: opportunities.id }).from(opportunities).where(eq(opportunities.demo, true));
    return rows.length;
  });
  return {
    sources: [
      { id: mockStormAdapter.id, label: mockStormAdapter.label, kind: "storm", mock: true, records: storms.length, used: storms.length, note: mockStormAdapter.source },
      { id: mockPermitAdapter.id, label: mockPermitAdapter.label, kind: "permit", mock: true, records: permits.length, used: leads.length, note: `${mockPermitAdapter.source} Kept roofs re-done ${OLD_ROOF_YEARS}+ years ago; skipped ${skippedRecent} with a permit in the last ${RECENT_PERMIT_DAYS} days (another contractor has them).` },
    ],
    prospectsAdded,
    opportunities: openOpps,
    skippedRecentPermits: skippedRecent,
  };
}

export interface OutreachDraft {
  opportunityId: string;
  to: string | null;
  subject: string;
  body: string;
  /** Why it can or can't be sent; checked again at send time. */
  canRequest: boolean;
  blockedReason: string | null;
  demo: boolean;
}

const KIND_WORD: Record<string, string> = { hail: "hail", wind: "high winds", tornado: "a tornado" };

/**
 * A first message, written from the opportunity's own evidence. Plain,
 * specific, no pressure, with a clear way to opt out. Staff can read it;
 * only managers can ask for approval and only owners can approve it.
 */
export async function draftFirstOutreach(input: Actor & { opportunityId: string }): Promise<OutreachDraft> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "finder.outreach.draft");
    await requireFeature(tx, input.orgId, "scout", { type: "user", id: input.actorUserId }, "finder.outreach.draft");
    const [row] = await tx
      .select({ o: opportunities, p: prospects })
      .from(opportunities)
      .innerJoin(prospects, and(eq(prospects.tenantId, opportunities.tenantId), eq(prospects.id, opportunities.prospectId)))
      .where(eq(opportunities.id, input.opportunityId));
    if (!row) throw new AppError("NOT_FOUND", "Opportunity not found");
    const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, input.orgId));
    const signals = row.o.signalIds.length ? await tx.select().from(signalObservations).where(inArray(signalObservations.id, row.o.signalIds)) : [];
    const top = signals.sort((a, b) => b.eventAt.getTime() - a.eventAt.getTime())[0];
    const business = org?.name ?? "our team";
    const name = row.p.name.replace(/\s*\((DEMO|MOCK)\)\s*$/, "");
    const first = name.split(/\s+/)[0] ?? "there";
    const street = row.p.address ? row.p.address.replace(/^\d+\s+/, "") : null;
    const when = top ? top.eventAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) : null;
    const what = top ? KIND_WORD[top.kind] ?? "a storm" : "recent storms";
    const subject = `A free roof check${street ? ` for ${street}` : ""} after ${when ? `the ${when} storm` : "the recent storm"}`;
    const body = [
      `Hi ${first},`,
      "",
      `This is ${business}. ${top ? `Weather reports show ${what} near ${row.p.city ?? "your area"} on ${when}.` : "There's been storm activity in your area."} Roofs that have been up for a while can take damage you can't see from the ground, and it's easier to deal with before the next rain.`,
      "",
      "If it would help, we can do a free 20-minute roof check and send you the photos either way. There's no obligation.",
      "",
      "Just reply to this email with a day that suits you.",
      "",
      business,
      "",
      `If you'd rather not hear from us, reply "stop" and we won't contact you again.`,
    ].join("\n");
    let blockedReason: string | null = null;
    if (!row.p.email) blockedReason = "There's no email address for this person, so this message can only be used as a script for a call or a visit.";
    else {
      const gate = await checkEmailAllowed(tx, [row.p.email]);
      if (!gate.allowed) blockedReason = gate.message;
    }
    return { opportunityId: row.o.id, to: row.p.email, subject, body, canRequest: !blockedReason, blockedReason, demo: row.o.demo || row.p.demo };
  });
}

/**
 * Turns an (edited) draft into one exact action waiting for an owner's OK:
 * a pre-planned tier-2, owner-only `scout.send_outreach` step bound by its
 * digest (same pattern as front-desk bookings). Nothing is sent until an owner
 * approves; the executor consumes that single-use approval and the tool
 * re-checks consent at send time. No agent gains new permissions.
 */
export async function requestOutreachApproval(input: Actor & { opportunityId: string; subject: string; body: string }): Promise<{ taskId: string; approvalId: string }> {
  const subject = input.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  const body = input.body.trim().slice(0, 5000);
  if (subject.length < 3 || body.length < 20) throw new AppError("VALIDATION", "Give the message a subject and a few sentences.");
  const draft = await draftFirstOutreach(input);
  if (!draft.canRequest || !draft.to) throw new AppError("CONFLICT", draft.blockedReason ?? "This message can't be sent.");
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "finder.outreach.request");
    const [scout] = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.kind, "scout"), eq(agents.status, "active")));
    if (!scout) throw new AppError("CONFLICT", "Scout isn't set up yet. Review your business profile in Scout setup first.");
    await consumeQuota(tx, input.orgId, "tasks", 1);
    const taskId = randomUUID();
    const approvalId = randomUUID();
    const args = { opportunityId: draft.opportunityId, to: draft.to, subject, body };
    const digest = actionDigest({ tenantId: input.orgId, taskId, agentId: scout.id, step: 0, tool: SCOUT_OUTREACH_TOOL, args });
    const summary = `Send a first email to ${draft.to}: "${subject}"`;
    await tx.insert(tasks).values({
      id: taskId,
      tenantId: input.orgId,
      requestedBy: input.actorUserId,
      assignedAgentId: scout.id,
      intent: `Send Scout's first outreach email to ${draft.to} (an owner approves first).`,
      title: `First message to ${draft.to}`,
      state: "WAITING_FOR_APPROVAL",
      input: { source: "scout_finder", scoutOpportunityId: draft.opportunityId },
      plan: { steps: [{ index: 0, tool: SCOUT_OUTREACH_TOOL, args, tier: 2, decision: "needs_approval", summary, digest, approvalId }] },
    });
    await tx.insert(approvalRequests).values({
      id: approvalId,
      tenantId: input.orgId,
      taskId,
      agentId: scout.id,
      toolName: SCOUT_OUTREACH_TOOL,
      tier: 2,
      actionDigest: digest,
      payload: { tool: SCOUT_OUTREACH_TOOL, args, step: 0, source: "scout_finder" },
      summary,
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    });
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "finder.outreach.request",
      target: `approval:${approvalId}`,
      approvalRequestId: approvalId,
      tier: 2,
      outcome: "success",
      metadata: { opportunityId: draft.opportunityId, taskId, demo: draft.demo, ownerOnly: true },
    });
    return { taskId, approvalId };
  });
}
