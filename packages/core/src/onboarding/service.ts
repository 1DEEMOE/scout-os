/**
 * Plug-and-play setup wizard.
 *
 * Never loosens approval tiers, consent, suppression, or pause-all.
 * Trial plan changes are audited. DEMO data is always flagged demo=true
 * and labelled "(DEMO)". No external sends. Connectors are "connect later"
 * markers only — no live OAuth from this module.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import {
  communicationPermissions,
  intelligenceSources,
  opportunities,
  organizations,
  prospects,
  routines,
  signalObservations,
  withTenant,
} from "@wos/db";
import { recordAudit } from "../audit";
import { applyPlan } from "../billing/plans";
import { AppError } from "../errors";
import { inviteMember, type InviteResult } from "../org/service";
import { ANY_ROLE, MANAGERS, inOrg, requireRole } from "../org/access";
import { createRoutine, executeRoutineRun, listRoutines } from "../routines/service";
import { importProspects, reviewBusinessProfile, saveBusinessProfile, uploadStormReports } from "../scout/service";
import { runScoutScan } from "../scout/service";
import { recordPermission } from "../scout/lifecycle";
import { applyCsvMapping, proposeCsvMapping, type LeadField } from "./csv-map";
import { getPreset, ONBOARDING_STEPS, type IndustryId, type OnboardingStepId } from "./presets";
import { lookupZip, normalizeZip } from "./zip-to-county";

export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
  href?: string;
}

export interface OnboardingState {
  orgId: string;
  orgName: string;
  industry: IndustryId | null;
  timezone: string | null;
  step: OnboardingStepId | null;
  completedAt: string | null;
  plan: string;
  checklist: ChecklistItem[];
  hasDemoData: boolean;
  hasMorningBriefing: boolean;
  hasBriefingRun: boolean;
  serviceAreaSummary: string | null;
}

type Actor = { actorUserId: string; orgId: string };

function parseIndustry(v: string | null | undefined): IndustryId | null {
  if (v === "roofing" || v === "general") return v;
  return null;
}

async function loadOrg(tx: Parameters<Parameters<typeof inOrg>[1]>[0], orgId: string) {
  const [org] = await tx
    .select({
      id: organizations.id,
      name: organizations.name,
      plan: organizations.plan,
      industry: organizations.industry,
      timezone: organizations.timezone,
      onboardingCompletedAt: organizations.onboardingCompletedAt,
      onboardingStep: organizations.onboardingStep,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org) throw new AppError("NOT_FOUND", "Organization not found");
  return org;
}


async function briefingRunCount(tx: Parameters<Parameters<typeof inOrg>[1]>[0], orgId: string): Promise<number> {
  const res = await tx.execute(sql`
    SELECT count(*)::int AS n
    FROM routine_runs rr
    INNER JOIN routines r ON r.id = rr.routine_id AND r.tenant_id = rr.tenant_id
    WHERE rr.tenant_id = ${orgId}::uuid
      AND rr.status = 'succeeded'
      AND r.kind = 'morning_briefing'
  `);
  return Number(res.rows[0]?.n ?? 0);
}

async function checklistOf(tx: Parameters<Parameters<typeof inOrg>[1]>[0], orgId: string, org: Awaited<ReturnType<typeof loadOrg>>): Promise<ChecklistItem[]> {
  const industry = parseIndustry(org.industry);
  const [demoP] = await tx.select({ n: sql<number>`count(*)::int` }).from(prospects).where(eq(prospects.demo, true));
  const [anyP] = await tx.select({ n: sql<number>`count(*)::int` }).from(prospects);
  const [rout] = await tx.select({ n: sql<number>`count(*)::int` }).from(routines).where(and(eq(routines.kind, "morning_briefing"), eq(routines.status, "active")));
  const runCount = await briefingRunCount(tx, orgId);
  const hasData = (demoP?.n ?? 0) > 0 || (anyP?.n ?? 0) > 0;
  const stepIdx = org.onboardingStep ? ONBOARDING_STEPS.indexOf(org.onboardingStep as OnboardingStepId) : -1;
  const base = `/orgs/${orgId}/setup`;
  return [
    { id: "industry", label: "Pick your industry", done: !!industry, href: base },
    { id: "basics", label: "Business name, service area, time zone", done: !!(org.timezone && industry), href: `${base}?step=basics` },
    {
      id: "data",
      label: industry === "roofing" ? "Load DEMO sample or import leads" : "Import leads (optional)",
      done: hasData || !!org.onboardingCompletedAt || stepIdx >= ONBOARDING_STEPS.indexOf("connect"),
      href: `${base}?step=data`,
    },
    {
      id: "connect",
      label: "Connect tools later (optional)",
      done: stepIdx >= ONBOARDING_STEPS.indexOf("connect") || !!org.onboardingCompletedAt,
      href: `${base}?step=connect`,
    },
    {
      id: "briefing",
      label: "Morning briefing ready",
      done: (rout?.n ?? 0) > 0 && runCount > 0,
      href: `/orgs/${orgId}/routines/briefing`,
    },
  ];
}


export async function getOnboardingState(input: Actor): Promise<OnboardingState> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "onboarding.read");
    const org = await loadOrg(tx, input.orgId);
    const [demoP] = await tx.select({ n: sql<number>`count(*)::int` }).from(prospects).where(eq(prospects.demo, true));
    const [demoS] = await tx.select({ n: sql<number>`count(*)::int` }).from(intelligenceSources).where(eq(intelligenceSources.demo, true));
    const list = await checklistOf(tx, input.orgId, org);
    const [rout] = await tx.select({ n: sql<number>`count(*)::int` }).from(routines).where(eq(routines.kind, "morning_briefing"));
    return {
      orgId: org.id,
      orgName: org.name,
      industry: parseIndustry(org.industry),
      timezone: org.timezone,
      step: (org.onboardingStep as OnboardingStepId | null) ?? null,
      completedAt: org.onboardingCompletedAt?.toISOString() ?? null,
      plan: org.plan,
      checklist: list,
      hasDemoData: (demoP?.n ?? 0) + (demoS?.n ?? 0) > 0,
      hasMorningBriefing: (rout?.n ?? 0) > 0,
      hasBriefingRun: list.find((c) => c.id === "briefing")?.done ?? false,
      serviceAreaSummary: null,
    };
  });
}

export async function chooseIndustry(input: Actor & { industry: IndustryId }): Promise<OnboardingState> {
  const preset = getPreset(input.industry);
  await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "onboarding.industry");
    const org = await loadOrg(tx, input.orgId);
    if (org.onboardingCompletedAt) throw new AppError("CONFLICT", "Setup is already finished. Change industry from Settings later.");
    await tx
      .update(organizations)
      .set({ industry: input.industry, onboardingStep: "basics" })
      .where(eq(organizations.id, input.orgId));
    await applyPlan(tx, input.orgId, preset.trialPlan, { type: "system", id: "onboarding" }, `onboarding trial: ${input.industry} by user:${input.actorUserId}`);
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "onboarding.industry",
      target: `organization:${input.orgId}`,
      tier: 1,
      outcome: "success",
      metadata: { industry: input.industry, trialPlan: preset.trialPlan },
    });
  });
  return getOnboardingState(input);
}

export async function saveBasics(
  input: Actor & {
    name: string;
    timezone: string;
    /** 5-digit ZIP preferred; looked up in the curated table. */
    zip?: string;
    /** Explicit county when ZIP is unknown. */
    county?: string;
    state?: string;
  },
): Promise<OnboardingState> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new AppError("VALIDATION", "Business name is required");
  const timezone = input.timezone.trim();
  if (!timezone || timezone.length > 64) throw new AppError("VALIDATION", "Time zone is required");
  // Validate IANA by attempting DateTimeFormat
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new AppError("VALIDATION", "Use an IANA time zone like America/New_York");
  }

  let county: string | null = null;
  let state: string | null = null;
  if (input.zip) {
    const hit = lookupZip(input.zip);
    if (hit) {
      county = hit.county;
      state = hit.state;
    } else if (input.county && input.state) {
      county = input.county.trim();
      state = input.state.trim().toUpperCase();
    } else {
      throw new AppError(
        "VALIDATION",
        `ZIP ${normalizeZip(input.zip) ?? input.zip} isn't in our quick-lookup table yet. Enter county and 2-letter state, or try a nearby metro ZIP.`,
      );
    }
  } else if (input.county && input.state) {
    county = input.county.trim();
    state = input.state.trim().toUpperCase();
  }

  await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "onboarding.basics");
    const org = await loadOrg(tx, input.orgId);
    const industry = parseIndustry(org.industry);
    if (!industry) throw new AppError("CONFLICT", "Pick an industry first");

    await tx
      .update(organizations)
      .set({ name, timezone, onboardingStep: "data" })
      .where(eq(organizations.id, input.orgId));
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "onboarding.basics",
      target: `organization:${input.orgId}`,
      tier: 1,
      outcome: "success",
      metadata: { timezone, county, state, zip: input.zip ? normalizeZip(input.zip) : null },
    });
  });

  // Roofing: save + auto-review profile so Scout isn't blocked. Review is still
  // an explicit manager action (this caller is a manager). Never loosens tiers.
  const stateAfter = await getOnboardingState(input);
  if (stateAfter.industry === "roofing") {
    if (!county || !state) throw new AppError("VALIDATION", "Roofing setup needs a service-area ZIP or county + state so Scout knows where to watch.");
    const preset = getPreset("roofing");
    await saveBusinessProfile({
      actorUserId: input.actorUserId,
      orgId: input.orgId,
      profile: {
        vertical: "roofing",
        website: "",
        services: preset.defaultServicesOffered.map((s) => s.replace(/_/g, " ")),
        idealCustomer: preset.idealCustomerNotes,
        serviceArea: { states: [], counties: [{ state, county }], center: null },
        settings: { radiusMiles: 15, lookbackDays: 30, minScore: 30, monthlyDataCostCents: 0, averageJobValueCents: 950000 },
      },
    });
    await reviewBusinessProfile({ actorUserId: input.actorUserId, orgId: input.orgId });
  }

  return getOnboardingState(input);
}

/** One-click DEMO sample. Every row is demo=true and labelled (DEMO). */
export async function loadDemoData(input: Actor): Promise<{ prospects: number; signals: number }> {
  const state = await getOnboardingState(input);
  if (state.industry !== "roofing") throw new AppError("CONFLICT", "DEMO storm sample is for the roofing preset. Import a CSV instead.");
  // Pull current profile counties for synthetic data alignment.
  const { getBusinessProfile } = await import("../scout/service");
  const profile = await getBusinessProfile(input);
  const counties =
    profile?.serviceArea && typeof profile.serviceArea === "object" && Array.isArray((profile.serviceArea as { counties?: unknown }).counties)
      ? ((profile.serviceArea as { counties: Array<{ state: string; county: string }> }).counties)
      : [{ state: "TX", county: "Dallas" }, { state: "TX", county: "Collin" }];
  const primary = counties[0] ?? { state: "TX", county: "Dallas" };
  const day = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
  const spc = [
    "Time,F_Scale,Location,County,State,Lat,Lon,Comments",
    `2340,UNK,4 NE Sampleville,${primary.county},${primary.state},32.95,-96.70,Brief touchdown reported by spotter. (DEMO)`,
    "Time,Speed,Location,County,State,Lat,Lon,Comments",
    `2215,70,Sampletown,${primary.county},${primary.state},32.90,-96.60,Measured gust at school. (DEMO)`,
    `0040,UNK,Sampletown,${primary.county},${primary.state},32.91,-96.55,Large limbs down. (DEMO)`,
    "Time,Size,Location,County,State,Lat,Lon,Comments",
    `2105,175,2 W Sampletown,${primary.county},${primary.state},32.95,-96.76,Golf ball size hail. (DEMO)`,
    `2120,125,Sampletown,${primary.county},${primary.state},32.91,-96.64,Half dollar size hail. (DEMO)`,
    `2150,075,Sampleville,${primary.county},${primary.state},33.02,-96.70,Penny size hail. (DEMO)`,
  ].join("\n");
  const second = counties[1] ?? primary;
  const prospectsCsv = [
    "name,email,phone,address,city,county,state,zip,lat,lon",
    `Maria Alvarez (DEMO),maria.alvarez@example.test,214-555-0101,12 Cedar Ln,Sampletown,${primary.county},${primary.state},75080,32.957,-96.745`,
    `James Okafor (DEMO),james.okafor@example.test,214-555-0102,48 Birch Ct,Sampletown,${primary.county},${primary.state},75040,32.915,-96.632`,
    `Priya Shah (DEMO),priya.shah@example.test,,7 Willow Way,Sampletown,${primary.county},${primary.state},75088,32.903,-96.551`,
    `Tom Becker (DEMO),,972-555-0104,301 Elm St,Sampletown,${primary.county},${primary.state},75149,,`,
    `Linda Nguyen (DEMO),linda.nguyen@example.test,,90 Oak Hollow,Sampleville,${second.county},${second.state},75023,33.031,-96.712`,
    `Carlos Ruiz (DEMO),carlos.ruiz@example.test,,5 Pecan Dr,Sampleville,${second.county},${second.state},75098,33.041,-96.505`,
  ].join("\n");

  await uploadStormReports({ ...input, csv: spc, reportDay: day, demo: true });
  const imported = await importProspects({
    ...input,
    csv: prospectsCsv,
    label: "DEMO sample homeowners",
    usageRights: "Invented sample records for trying Scout. Not real people. Domains are example.test.",
    attest: true,
    demo: true,
  });
  await recordPermission({
    ...input,
    email: "james.okafor@example.test",
    basis: "existing_customer",
    evidence: "DEMO: gutter repair customer in 2024",
  });
  const scan = await withTenant(input.orgId, (tx) => runScoutScan(tx, input.orgId, { type: "system", id: "onboarding-demo" }));
  await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "onboarding.demo");
    await tx.update(organizations).set({ onboardingStep: "connect" }).where(eq(organizations.id, input.orgId));
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "onboarding.demo_load",
      target: `organization:${input.orgId}`,
      tier: 1,
      outcome: "success",
      metadata: { prospects: (imported as { added?: number })?.added ?? null, opportunities: (scan as { created?: number })?.created ?? null },
    });
  });
  return { prospects: Number((imported as { added?: number })?.added ?? 0), signals: 6 };
}

/** Removes every row flagged demo=true for this tenant. One click. */
export async function clearDemoData(input: Actor): Promise<{ removed: Record<string, number> }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "onboarding.demo_clear");
    // Opportunities CASCADE to opportunity_events. Prospects / signals / sources are demo-flagged.
    const opps = await tx.delete(opportunities).where(eq(opportunities.demo, true)).returning({ id: opportunities.id });
    const prosp = await tx.delete(prospects).where(eq(prospects.demo, true)).returning({ id: prospects.id });
    const sigs = await tx.delete(signalObservations).where(eq(signalObservations.demo, true)).returning({ id: signalObservations.id });
    const srcs = await tx.delete(intelligenceSources).where(eq(intelligenceSources.demo, true)).returning({ id: intelligenceSources.id });
    // Permissions: revoke (UPDATE) — app_user has no DELETE on this table.
    const perms = await tx
      .update(communicationPermissions)
      .set({ revokedBy: input.actorUserId, revokedAt: new Date() })
      .where(and(like(communicationPermissions.evidence, "DEMO:%"), isNull(communicationPermissions.revokedAt)))
      .returning({ id: communicationPermissions.id });
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "onboarding.demo_clear",
      target: `organization:${input.orgId}`,
      tier: 2,
      outcome: "success",
      metadata: { opportunities: opps.length, prospects: prosp.length, signals: sigs.length, sources: srcs.length, permissionsRevoked: perms.length },
    });
    return {
      removed: {
        opportunities: opps.length,
        prospects: prosp.length,
        signals: sigs.length,
        sources: srcs.length,
        permissionsRevoked: perms.length,
      },
    };
  });
}

export function previewLeadCsv(csvText: string) {
  return proposeCsvMapping(csvText, { previewLimit: 5 });
}

export async function importLeadCsv(
  input: Actor & { csv: string; mapping: Record<string, LeadField>; label?: string },
): Promise<{ imported: number }> {
  const rows = applyCsvMapping(input.csv, input.mapping);
  if (!rows.length) throw new AppError("VALIDATION", "No rows with a name to import.");
  // Rebuild a CSV the existing importer understands.
  const header = "name,email,phone,address,city,county,state,zip";
  const lines = rows.map((r) =>
    [r.fullName, r.email ?? "", r.phone ?? "", r.addressLine1 ?? "", r.city ?? "", r.county ?? "", r.state ?? "", r.postalCode ?? ""]
      .map((c) => `"${String(c).replace(/"/g, '""')}"`)
      .join(","),
  );
  const csv = [header, ...lines].join("\n");
  const state = await getOnboardingState(input);
  if (state.industry === "roofing") {
    const result = await importProspects({
      ...input,
      csv,
      label: (input.label ?? "Onboarding import").slice(0, 120),
      usageRights: "Customer-supplied list. Importer attested they have the right to use these contacts.",
      attest: true,
      demo: false,
    });
    await inOrg(input.orgId, async (tx) => {
      await tx.update(organizations).set({ onboardingStep: "connect" }).where(eq(organizations.id, input.orgId));
    });
    return { imported: Number((result as { added?: number })?.added ?? rows.length) };
  }
  // General SMB: store as prospects only if scout feature exists; otherwise refuse with guidance.
  throw new AppError(
    "CONFLICT",
    "CSV lead import into Scout prospects needs the Scout feature (roofing preset). Connect HubSpot later for a general CRM import.",
  );
}

export async function skipDataStep(input: Actor): Promise<OnboardingState> {
  await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "onboarding.data_skip");
    await tx.update(organizations).set({ onboardingStep: "connect" }).where(eq(organizations.id, input.orgId));
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "onboarding.data_skip",
      target: `organization:${input.orgId}`,
      tier: 1,
      outcome: "success",
    });
  });
  return getOnboardingState(input);
}

/** Records "connect later" — no live OAuth. */
export async function markConnectLater(input: Actor & { skipped: string[] }): Promise<OnboardingState> {
  await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "onboarding.connect");
    await tx.update(organizations).set({ onboardingStep: "invite" }).where(eq(organizations.id, input.orgId));
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "onboarding.connect_later",
      target: `organization:${input.orgId}`,
      tier: 1,
      outcome: "success",
      metadata: { skipped: input.skipped.slice(0, 10) },
    });
  });
  return getOnboardingState(input);
}

export async function inviteDuringOnboarding(input: Actor & { email: string; role: string }): Promise<InviteResult> {
  const result = await inviteMember({
    actorUserId: input.actorUserId,
    orgId: input.orgId,
    email: input.email,
    role: input.role,
  });
  await inOrg(input.orgId, async (tx) => {
    await tx.update(organizations).set({ onboardingStep: "invite" }).where(eq(organizations.id, input.orgId));
  });
  return result;
}

export async function skipInvite(input: Actor): Promise<OnboardingState> {
  await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "onboarding.invite_skip");
    await tx.update(organizations).set({ onboardingStep: "finish" }).where(eq(organizations.id, input.orgId));
  });
  return getOnboardingState(input);
}

async function ensureMorningBriefing(input: Actor & { timezone: string }) {
  const existing = await listRoutines(input);
  const found = existing.find((r) => r.kind === "morning_briefing");
  if (found) return found;
  const preset = getPreset("roofing"); // same 7am default for general
  return createRoutine({
    actorUserId: input.actorUserId,
    orgId: input.orgId,
    kind: "morning_briefing",
    name: "Morning Briefing",
    hour: preset.morningBriefingHourLocal,
    minute: preset.morningBriefingMinuteLocal,
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    timezone: input.timezone,
  });
}

/**
 * Finishes the wizard: ensures Morning Briefing routine, runs it once inline
 * (no external send), marks onboarding complete. Returns briefing run id.
 */
export async function finishOnboarding(input: Actor): Promise<{ briefingRunId: string | null; routineId: string }> {
  const state = await getOnboardingState(input);
  if (!state.industry) throw new AppError("CONFLICT", "Pick an industry first");
  if (!state.timezone) throw new AppError("CONFLICT", "Save business basics (including time zone) first");

  const routine = await ensureMorningBriefing({ ...input, timezone: state.timezone });
  const clientRef = randomUUID().replace(/-/g, "");
  const outcome = await executeRoutineRun({
    tenantId: input.orgId,
    routineId: routine.id,
    scheduledFor: new Date().toISOString(),
    trigger: "manual",
    clientRef,
  });
  const briefingRunId = "runId" in outcome ? outcome.runId : null;
  if (outcome.status === "failed") {
    throw new AppError("CONFLICT", `First briefing failed: ${"error" in outcome ? outcome.error : "unknown"}`);
  }

  await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "onboarding.finish");
    await tx
      .update(organizations)
      .set({ onboardingCompletedAt: new Date(), onboardingStep: "finish" })
      .where(eq(organizations.id, input.orgId));
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "onboarding.finish",
      target: `organization:${input.orgId}`,
      tier: 1,
      outcome: "success",
      metadata: { routineId: routine.id, briefingRunId, briefingStatus: outcome.status },
    });
  });

  return { briefingRunId, routineId: routine.id };
}
