/**
 * Plug-and-play for selling: the operator creates a client workspace and gets
 * one invite link; the client sets a password (or uses Google), lands in a
 * workspace that is already named, and finishes setup in at most three short,
 * skippable steps that end with a real first briefing.
 *
 * Never loosens approval tiers, consent, suppression or pause-all. Sample data
 * is always demo=true and labelled (DEMO). Nothing is sent externally.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { organizationInvitations, organizations, withTenant } from "@wos/db";
import { recordAudit } from "../audit";
import { applyPlan } from "../billing/plans";
import { AppError } from "../errors";
import { logger } from "../logger";
import { MANAGERS, inOrg, requireRole } from "../org/access";
import { acceptUrlFor, hashToken, INVITE_TTL_MS } from "../org/service";
import { assertPlatformAdmin } from "../platform/admin";
import { getBusinessProfile, listOpportunities, reviewBusinessProfile, saveBusinessProfile } from "../scout/service";
import { legacyColumn, requirePack, writePackId } from "../industries/store";
import { noteSetupFinished, noteSetupStarted } from "../pilot/metrics";
import { getPreset, type IndustryId } from "./presets";
import { approveAllTemplates, stagePackTemplates } from "../speed/service";
import { finishOnboarding, getOnboardingState, loadDemoData, type OnboardingState } from "./service";
import { lookupZip, normalizeZip } from "./zip-to-county";

type Actor = { actorUserId: string; orgId: string };

const tzSchema = z.string().trim().min(1).max(64).refine((tz) => {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Use a time zone like America/New_York");

const provisionSchema = z.object({
  name: z.string().trim().min(1, "Business name is required").max(120, "Business name is too long"),
  industry: z.string().min(1).max(40),
  clientEmail: z.string().trim().toLowerCase().email("Enter the client's email address").max(254),
  confirmEmail: z.string().trim().toLowerCase(),
  zip: z.string().trim().max(10).optional(),
  timezone: tzSchema,
});

export interface ProvisionResult {
  orgId: string;
  /** Shown once. Only the hash is stored. */
  inviteUrl: string;
  expiresAt: string;
}

/**
 * Operator-only. Creates the workspace (named, trade preset and trial plan
 * applied) and a single owner invitation for the client. The operator does
 * NOT become a member: they can't read the client's data afterwards (least
 * privilege). Granting ownership is a tier-4 access change, so it needs the
 * client's email typed twice (second confirmation) and is audited at tier 4.
 */
export async function provisionClientWorkspace(input: {
  actorUserId: string;
  name: string;
  industry: IndustryId;
  clientEmail: string;
  confirmEmail: string;
  zip?: string;
  timezone: string;
}): Promise<ProvisionResult> {
  await assertPlatformAdmin(input.actorUserId, "platform.workspace.provision");
  const r = provisionSchema.safeParse(input);
  if (!r.success) throw new AppError("VALIDATION", r.error.issues[0]?.message ?? "Check the details");
  const v = r.data;
  if (v.confirmEmail !== v.clientEmail) throw new AppError("VALIDATION", "The two email addresses don't match. Type the client's email again to confirm.");
  let zip: string | null = null;
  if (v.zip) {
    zip = normalizeZip(v.zip);
    if (!zip) throw new AppError("VALIDATION", "ZIP should be 5 digits");
  }

  const orgId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const invitationId = randomUUID();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const pack = requirePack(v.industry);
  const preset = getPreset(v.industry);
  await withTenant(orgId, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: v.name, industry: legacyColumn(pack), timezone: v.timezone, onboardingStep: "basics" });
    await writePackId(tx, orgId, pack.id, input.actorUserId);
    await noteSetupStarted(tx, orgId, input.actorUserId);
    await stagePackTemplates(tx, orgId, input.actorUserId, pack.id);
    await applyPlan(tx, orgId, preset.trialPlan, { type: "system", id: "provisioning" }, `client workspace trial: ${v.industry} by platform admin user:${input.actorUserId}`);
    await tx.insert(organizationInvitations).values({
      id: invitationId,
      tenantId: orgId,
      email: v.clientEmail,
      role: "owner",
      tokenHash: hashToken(token),
      invitedBy: input.actorUserId,
      expiresAt,
    });
    await recordAudit(tx, {
      tenantId: orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "platform.workspace.provision",
      target: `organization:${orgId}`,
      tier: 4,
      outcome: "success",
      metadata: { industry: v.industry, trialPlan: preset.trialPlan, invitationId, ownerEmail: v.clientEmail, confirmed: "email typed twice" },
    });
  });
  logger.info({ orgId, actor: input.actorUserId, industry: v.industry }, "client workspace provisioned");

  // Display-only hints for the welcome screen; the token is the only secret and
  // acceptance still checks the signed-in email against the invitation.
  const url = new URL(acceptUrlFor(orgId, token));
  url.searchParams.set("email", v.clientEmail);
  url.searchParams.set("ws", v.name);
  if (zip) url.searchParams.set("zip", zip);
  return { orgId, inviteUrl: url.toString(), expiresAt: expiresAt.toISOString() };
}

/**
 * Step 1: business name and trade (pre-filled). ZIP sets Scout's service area
 * for roofing; without it Scout simply waits until one is added.
 */
export async function quickstartBusiness(input: Actor & { name: string; industry: IndustryId; timezone: string; zip?: string }): Promise<OnboardingState> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new AppError("VALIDATION", "Business name is required");
  const tz = tzSchema.safeParse(input.timezone);
  if (!tz.success) throw new AppError("VALIDATION", "Use a time zone like America/New_York");
  const hit = input.zip ? lookupZip(input.zip) : null;
  if (input.zip && !hit) throw new AppError("VALIDATION", `We don't know ZIP ${normalizeZip(input.zip) ?? input.zip} yet. Try a nearby metro ZIP, or leave it blank and add your area later.`);

  await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "onboarding.quickstart.business");
    const [org] = await tx.select({ industry: organizations.industry, completed: organizations.onboardingCompletedAt }).from(organizations).where(eq(organizations.id, input.orgId));
    if (!org) throw new AppError("NOT_FOUND", "Organization not found");
    const pack = requirePack(input.industry);
    const industryChanged = org.industry !== legacyColumn(pack);
    if (industryChanged && org.completed) throw new AppError("CONFLICT", "Setup is already finished. Change your trade from Settings.");
    await tx.update(organizations).set({ name, timezone: tz.data, industry: legacyColumn(pack), onboardingStep: "connect" }).where(eq(organizations.id, input.orgId));
    await noteSetupStarted(tx, input.orgId, input.actorUserId);
    await writePackId(tx, input.orgId, pack.id, input.actorUserId);
    await stagePackTemplates(tx, input.orgId, input.actorUserId, pack.id);
    if (industryChanged) await applyPlan(tx, input.orgId, getPreset(input.industry).trialPlan, { type: "system", id: "onboarding" }, `onboarding trial: ${input.industry} by user:${input.actorUserId}`);
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "onboarding.quickstart.business",
      target: `organization:${input.orgId}`,
      tier: 1,
      outcome: "success",
      metadata: { industry: input.industry, timezone: tz.data, zip: hit ? normalizeZip(input.zip!) : null },
    });
  });

  if (input.industry === "roofing" && hit) {
    const preset = getPreset("roofing");
    await saveBusinessProfile({
      actorUserId: input.actorUserId,
      orgId: input.orgId,
      profile: {
        vertical: "roofing",
        website: "",
        services: preset.defaultServicesOffered.map((s) => s.replace(/_/g, " ")),
        idealCustomer: preset.idealCustomerNotes,
        serviceArea: { states: [], counties: [{ state: hit.state, county: hit.county }], center: null },
        settings: { radiusMiles: 15, lookbackDays: 30, minScore: 30, monthlyDataCostCents: 0, averageJobValueCents: 950000 },
      },
    });
    await reviewBusinessProfile({ actorUserId: input.actorUserId, orgId: input.orgId });
  }
  return getOnboardingState(input);
}

/** Step 2 skipped (or done elsewhere): remember the step so the progress card is right. */
export async function quickstartSkipConnect(input: Actor): Promise<void> {
  await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "onboarding.quickstart.connect");
    await tx.update(organizations).set({ onboardingStep: "invite" }).where(eq(organizations.id, input.orgId));
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "onboarding.quickstart.connect_skip", target: `organization:${input.orgId}`, tier: 1, outcome: "success" });
  });
}

export interface QuickstartFinish {
  briefingRunId: string | null;
  samples: { id: string; name: string; score: number; city: string | null }[];
}

/**
 * Step 3: what Scout should watch. Every option does something real: the
 * briefing time sets the routine; "samples" loads three-plus DEMO prospects
 * (roofing) so there's something to look at right away. Then the first
 * briefing runs inline — the first win.
 */
export async function finishQuickstart(input: Actor & { briefingHour: number; samples: boolean; timezone: string; approveTemplates?: boolean }): Promise<QuickstartFinish> {
  if (!Number.isInteger(input.briefingHour) || input.briefingHour < 5 || input.briefingHour > 10) throw new AppError("VALIDATION", "Pick a briefing time between 5 and 10 am");
  let state = await getOnboardingState(input);
  if (!state.industry || !state.timezone) {
    // Step 1 was skipped entirely: fall back to what the operator set up.
    state = await quickstartBusiness({ ...input, name: state.orgName, industry: state.industry ?? "general", timezone: state.timezone ?? input.timezone });
  }
  let samples: QuickstartFinish["samples"] = [];
  if (input.samples && state.industry === "roofing" && !state.hasDemoData) {
    if (!(await getBusinessProfile(input))) throw new AppError("CONFLICT", "Add your service-area ZIP in step 1 so the samples land in your area, or untick samples.");
    await loadDemoData(input);
  }
  if (input.approveTemplates) await approveAllTemplates(input);
  const { briefingRunId } = await finishOnboarding({ ...input, briefingHour: input.briefingHour });
  if (state.industry === "roofing") {
    const opps = await listOpportunities({ ...input, limit: 3 });
    samples = opps.map((o) => ({ id: o.id, name: o.prospect.name, score: o.score, city: o.prospect.city }));
  }
  await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "onboarding.quickstart.finish");
    await noteSetupFinished(tx, input.orgId, input.actorUserId, input.approveTemplates === true);
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "onboarding.quickstart.finish",
      target: `organization:${input.orgId}`,
      tier: 1,
      outcome: "success",
      metadata: { briefingHour: input.briefingHour, samples: input.samples, briefingRunId },
    });
  });
  return { briefingRunId, samples };
}
