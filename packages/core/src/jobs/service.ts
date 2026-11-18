import { randomUUID } from "node:crypto";
import { and, desc, eq, like, ne } from "drizzle-orm";
import { agents, approvalRequests, memoryRecords, organizationMembers, tasks, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { actionDigest } from "../engine/digest";
import { AppError } from "../errors";
import { buildEstimate, getElitePack, validateIntake, type Answers, type ElitePack, type Estimate, type EstimateConfig, type Jurisdiction } from "../industries/elite";
import { readPackId } from "../industries/store";
import { ANY_ROLE, inOrg, MANAGERS, requireRole, STAFF } from "../org/access";

/**
 * Vertical jobs workspace: the elite-pack engine (intake → estimate → dispatch)
 * turned into a product. A job carries a customer's intake answers for the
 * org's industry pack, a live-recomputed estimate, a crew, and a status
 * pipeline.
 *
 * Persistence is interim: records live in memory_records (scope "jobs", one
 * row per job, scopeRef `job:<id>`) until proposed migration 0026_jobs.sql is
 * reviewed and applied — the same interim pattern as the industry-pack store
 * and managed numbers. Estimates are NOT stored: they are a deterministic
 * function of (pack, answers, org pricing config), so they are rebuilt on
 * every read. That keeps each record under the memory_records 2000-char cap
 * and means a pack's example-pricing edits never strand a stale number.
 *
 * Sending is never direct. The estimate engine refuses to unblock while prices
 * are still examples or required business fields are missing, and the send
 * itself goes through the approvals engine at the pack's compliance floor
 * (see the jobs.send_estimate tool). Audit rows carry job ids and statuses
 * only — never customer names, emails, or phone numbers (PII stays out of
 * logs and audit metadata).
 */

const REF_PREFIX = "job:";
const CONFIG_REF = "jobs-config";
/** memory_records content cap (see managed-service.ts). */
const CONTENT_CAP = 2000;

export const JOB_STATUSES = [
  "inquiry",
  "estimate_ready",
  "approval_pending",
  "estimate_sent",
  "booked",
  "dispatched",
  "in_progress",
  "done",
  "cancelled",
  "lost",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses where the job is still alive on the board. */
export const ACTIVE_STATUSES: readonly JobStatus[] = ["inquiry", "estimate_ready", "approval_pending", "estimate_sent", "booked", "dispatched", "in_progress"];

export interface JobRecord {
  v: 1;
  id: string;
  tenantId: string;
  packId: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  answers: Answers;
  jurisdiction: Jurisdiction;
  status: JobStatus;
  crew: string[];
  scheduledFor: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

/** Owner-controlled pricing/business config per org. Owner-only to change. */
export interface JobsConfig {
  v: 1;
  /** True only after the owner replaced example prices with their own. */
  ownerConfiguredPrices: boolean;
  /** Owner-edited rule overrides keyed by pricing-rule id. */
  overrides: Record<string, { cents?: number; unitCents?: number; bps?: number }>;
  /** Values the pack's compliance.requiredBusinessFields demand (e.g. USDOT). */
  businessFields: Record<string, string>;
}

const DEFAULT_CONFIG: JobsConfig = { v: 1, ownerConfiguredPrices: false, overrides: {}, businessFields: {} };

/** The pipeline transitions a human may trigger. Anything else is a bug or an attack. */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  inquiry: ["estimate_ready", "cancelled"],
  estimate_ready: ["approval_pending", "cancelled"],
  // Rejection path is explicit: a manager sends it back to draft.
  approval_pending: ["estimate_sent", "estimate_ready", "cancelled"],
  estimate_sent: ["booked", "lost", "cancelled"],
  booked: ["dispatched", "cancelled"],
  dispatched: ["in_progress", "cancelled"],
  in_progress: ["done", "cancelled"],
  done: [],
  cancelled: [],
  lost: [],
};

export class JobTransitionError extends AppError {
  constructor(from: JobStatus, to: JobStatus) {
    super("CONFLICT", `A job cannot move from "${from}" to "${to}".`);
  }
}

/* ------------------------------------------------------------- storage */

function parseJob(content: string): JobRecord | null {
  try {
    const v = JSON.parse(content) as JobRecord;
    return v && v.v === 1 && typeof v.id === "string" && typeof v.tenantId === "string" && typeof v.packId === "string" ? v : null;
  } catch {
    return null;
  }
}

async function putJob(tx: Tx, job: JobRecord): Promise<void> {
  const content = JSON.stringify(job);
  if (content.length > CONTENT_CAP) {
    throw new AppError("VALIDATION", "This job has grown past what the interim store can hold. Shorten the intake answers.");
  }
  const ref = REF_PREFIX + job.id;
  await tx.delete(memoryRecords).where(and(eq(memoryRecords.tenantId, job.tenantId), eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, ref)));
  await tx.insert(memoryRecords).values({ tenantId: job.tenantId, layer: "org", scopeRef: ref, content, trust: "verified", createdByUser: job.createdBy });
}

/** Read inside an RLS-scoped tx — another org's jobs are invisible by construction. */
async function readJobTx(tx: Tx, tenantId: string, jobId: string): Promise<JobRecord> {
  const rows = await tx
    .select({ content: memoryRecords.content })
    .from(memoryRecords)
    .where(and(eq(memoryRecords.tenantId, tenantId), eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, REF_PREFIX + jobId)))
    .orderBy(desc(memoryRecords.createdAt))
    .limit(1);
  const job = rows[0] ? parseJob(rows[0].content) : null;
  if (!job) throw new AppError("NOT_FOUND", "Job not found");
  return job;
}

function parseConfig(content: string): JobsConfig | null {
  try {
    const v = JSON.parse(content) as JobsConfig;
    return v && v.v === 1 && typeof v.ownerConfiguredPrices === "boolean" ? v : null;
  } catch {
    return null;
  }
}

async function readConfigTx(tx: Tx, tenantId: string): Promise<JobsConfig> {
  const rows = await tx
    .select({ content: memoryRecords.content })
    .from(memoryRecords)
    .where(and(eq(memoryRecords.tenantId, tenantId), eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, CONFIG_REF)))
    .orderBy(desc(memoryRecords.createdAt))
    .limit(1);
  return (rows[0] && parseConfig(rows[0].content)) || { ...DEFAULT_CONFIG };
}

async function putConfig(tx: Tx, tenantId: string, cfg: JobsConfig, actorUserId: string): Promise<void> {
  const content = JSON.stringify(cfg);
  if (content.length > CONTENT_CAP) throw new AppError("VALIDATION", "Jobs config is too large to store.");
  await tx.delete(memoryRecords).where(and(eq(memoryRecords.tenantId, tenantId), eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, CONFIG_REF)));
  await tx.insert(memoryRecords).values({ tenantId, layer: "org", scopeRef: CONFIG_REF, content, trust: "verified", createdByUser: actorUserId });
}

async function requireElitePack(tx: Tx): Promise<{ packId: string; pack: ElitePack }> {
  const packId = await readPackId(tx);
  const pack = packId ? getElitePack(packId) : undefined;
  if (!packId || !pack) {
    throw new AppError("VALIDATION", "This workspace's industry has no elite pack yet, so the jobs workspace is not available for it.");
  }
  return { packId, pack };
}

/** The estimate engine needs a jurisdiction; a pack with a move_type intake field decides it. */
function jurisdictionFromAnswers(pack: ElitePack, answers: Answers): Jurisdiction {
  if (pack.intake.some((f) => f.id === "move_type")) return answers["move_type"] === "long" ? "interstate" : "intrastate";
  return "intrastate";
}

function estimateConfigFor(job: JobRecord, cfg: JobsConfig): EstimateConfig {
  return {
    jurisdiction: job.jurisdiction,
    ownerConfiguredPrices: cfg.ownerConfiguredPrices,
    ownerAllowsBinding: false, // owner switch is a deliberate future step; binding stays off
    businessProfile: cfg.businessFields,
    overrides: cfg.overrides,
  };
}

function jobView(job: JobRecord, pack: ElitePack, cfg: JobsConfig): JobRecord & { estimate: Estimate } {
  return { ...job, estimate: buildEstimate(pack, job.answers, estimateConfigFor(job, cfg)) };
}

export type JobView = ReturnType<typeof jobView>;

function move(job: JobRecord, to: JobStatus): JobRecord {
  if (job.status === to) return job; // idempotent retries land here
  if (!TRANSITIONS[job.status].includes(to)) throw new JobTransitionError(job.status, to);
  return { ...job, status: to, updatedAt: new Date().toISOString() };
}

/* ------------------------------------------------------------- queries */

export async function listJobs(input: { actorUserId: string; orgId: string; status?: JobStatus }): Promise<JobView[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "job.list");
    const { pack } = await requireElitePack(tx);
    const cfg = await readConfigTx(tx, input.orgId);
    const rows = await tx
      .select({ content: memoryRecords.content })
      .from(memoryRecords)
      .where(and(eq(memoryRecords.tenantId, input.orgId), eq(memoryRecords.layer, "org"), like(memoryRecords.scopeRef, `${REF_PREFIX}%`)))
      .orderBy(desc(memoryRecords.createdAt))
      .limit(500);
    const jobs = rows.map((r) => parseJob(r.content)).filter((j): j is JobRecord => j !== null);
    return jobs.filter((j) => !input.status || j.status === input.status).map((j) => jobView(j, pack, cfg));
  });
}

export async function getJob(input: { actorUserId: string; orgId: string; jobId: string }): Promise<JobView> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "job.read");
    const { pack } = await requireElitePack(tx);
    const cfg = await readConfigTx(tx, input.orgId);
    return jobView(await readJobTx(tx, input.orgId, input.jobId), pack, cfg);
  });
}

/** Pack intake fields + pricing state for rendering the new-job form. Any role may read config. */
export async function jobFormConfig(input: { actorUserId: string; orgId: string }): Promise<{
  packId: string;
  intake: ElitePack["intake"];
  priceBasis: "example" | "owner_configured";
  requiredBusinessFields: { id: string; label: string; filled: boolean }[];
}> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "job.form");
    const { packId, pack } = await requireElitePack(tx);
    const cfg = await readConfigTx(tx, input.orgId);
    return {
      packId,
      intake: pack.intake,
      priceBasis: cfg.ownerConfiguredPrices ? "owner_configured" : "example",
      requiredBusinessFields: pack.compliance.requiredBusinessFields.map((f) => ({
        id: f.id,
        label: f.label,
        filled: Boolean(cfg.businessFields[f.id]?.trim()),
      })),
    };
  });
}

/* -------------------------------------------------------- owner pricing */

/** Owner confirms real prices (optionally overriding example rule figures). Tier 2 audit. */
export async function confirmJobsPricing(input: {
  actorUserId: string;
  orgId: string;
  overrides?: Record<string, { cents?: number; unitCents?: number; bps?: number }>;
}): Promise<{ priceBasis: "owner_configured" }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ["owner"], "job.pricing.confirm");
    const { pack } = await requireElitePack(tx);
    const cfg = await readConfigTx(tx, input.orgId);
    // Reject overrides that name rules the pack does not have — a typo must fail, not silently no-op.
    const ruleIds = new Set([...Object.values(pack.pricing.variants).flat(), ...pack.pricing.common].map((r) => r.id));
    for (const id of Object.keys(input.overrides ?? {})) {
      if (!ruleIds.has(id)) throw new AppError("VALIDATION", `Unknown pricing rule "${id}".`);
    }
    const next: JobsConfig = { ...cfg, ownerConfiguredPrices: true, overrides: { ...cfg.overrides, ...(input.overrides ?? {}) } };
    await putConfig(tx, input.orgId, next, input.actorUserId);
    await recordAudit(tx, {
      tenantId: input.orgId, actorType: "user", actorId: input.actorUserId,
      action: "job.pricing.confirm", tier: 2, outcome: "success",
      metadata: { overrides: Object.keys(input.overrides ?? {}).length },
    });
    return { priceBasis: "owner_configured" };
  });
}

/** Owner/manager records business-profile values the pack's compliance demands. */
export async function saveJobsBusinessFields(input: {
  actorUserId: string;
  orgId: string;
  fields: Record<string, string>;
}): Promise<{ filled: number }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "job.business_fields");
    const { pack } = await requireElitePack(tx);
    const cfg = await readConfigTx(tx, input.orgId);
    const allowed = new Set(pack.compliance.requiredBusinessFields.map((f) => f.id));
    const fields: Record<string, string> = { ...cfg.businessFields };
    for (const [k, v] of Object.entries(input.fields)) {
      if (!allowed.has(k)) throw new AppError("VALIDATION", `Unknown business field "${k}".`);
      const val = v.trim().slice(0, 120);
      if (val) fields[k] = val;
      else delete fields[k];
    }
    await putConfig(tx, input.orgId, { ...cfg, businessFields: fields }, input.actorUserId);
    await recordAudit(tx, {
      tenantId: input.orgId, actorType: "user", actorId: input.actorUserId,
      action: "job.business_fields", tier: 1, outcome: "success",
      metadata: { keys: Object.keys(input.fields).sort() }, // ids only, never values
    });
    return { filled: Object.keys(fields).length };
  });
}

/* ----------------------------------------------------------- mutations */

export async function createJob(input: {
  actorUserId: string;
  orgId: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  answers: Answers;
}): Promise<{ jobId: string }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "job.create");
    const { packId, pack } = await requireElitePack(tx);

    // Answers arrive from a browser: treat every value as untrusted external data.
    const result = validateIntake(pack, input.answers);
    if (!result.ok) throw new AppError("VALIDATION", `Intake incomplete: ${[...result.missing, ...result.errors].join("; ")}`);

    const now = new Date().toISOString();
    const job: JobRecord = {
      v: 1,
      id: randomUUID(),
      tenantId: input.orgId,
      packId,
      customerName: input.customerName.trim().slice(0, 120),
      customerEmail: input.customerEmail?.trim().slice(0, 200) || null,
      customerPhone: input.customerPhone?.trim().slice(0, 40) || null,
      answers: input.answers,
      jurisdiction: jurisdictionFromAnswers(pack, input.answers),
      status: "inquiry",
      crew: [],
      scheduledFor: null,
      createdBy: input.actorUserId,
      createdAt: now,
      updatedAt: now,
      sentAt: null,
    };
    if (!job.customerName) throw new AppError("VALIDATION", "Customer name is required");
    await putJob(tx, job);
    await recordAudit(tx, {
      tenantId: input.orgId, actorType: "user", actorId: input.actorUserId,
      action: "job.create", target: `job:${job.id}`, tier: 0, outcome: "success",
      metadata: { packId },
    });
    return { jobId: job.id };
  });
}

/** Runs the deterministic estimate engine and moves the job to estimate_ready. */
export async function prepareEstimate(input: { actorUserId: string; orgId: string; jobId: string }): Promise<{ estimate: Estimate }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "job.estimate");
    const { pack } = await requireElitePack(tx);
    const cfg = await readConfigTx(tx, input.orgId);
    let job = await readJobTx(tx, input.orgId, input.jobId);
    const estimate = buildEstimate(pack, job.answers, estimateConfigFor(job, cfg));
    if (!estimate.lines.length) throw new AppError("VALIDATION", "The intake answers produce no estimate lines — check the answers first.");
    job = move(job, "estimate_ready");
    await putJob(tx, job);
    await recordAudit(tx, {
      tenantId: input.orgId, actorType: "user", actorId: input.actorUserId,
      action: "job.estimate", target: `job:${job.id}`, tier: 0, outcome: "success",
      metadata: { totalCents: estimate.totalCents, lines: estimate.lines.length, blocked: estimate.blockedReasons.length },
    });
    return { estimate };
  });
}

/** Crew assignment: every id must be an active non-viewer member of THIS org (RLS-scoped read). */
export async function assignCrew(input: { actorUserId: string; orgId: string; jobId: string; memberIds: string[] }): Promise<{ crew: string[] }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "job.assign");
    const job = await readJobTx(tx, input.orgId, input.jobId);
    if (["done", "cancelled", "lost"].includes(job.status)) throw new JobTransitionError(job.status, job.status);
    const ids = [...new Set(input.memberIds)].slice(0, 20);
    if (ids.length) {
      const rows = await tx
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.tenantId, input.orgId), ne(organizationMembers.role, "viewer")));
      const valid = new Set(rows.map((r) => r.userId));
      if (ids.some((i) => !valid.has(i))) throw new AppError("VALIDATION", "Crew members must be active members of this workspace.");
    }
    await putJob(tx, { ...job, crew: ids, updatedAt: new Date().toISOString() });
    await recordAudit(tx, {
      tenantId: input.orgId, actorType: "user", actorId: input.actorUserId,
      action: "job.assign", target: `job:${job.id}`, tier: 0, outcome: "success",
      metadata: { crew: ids.length },
    });
    return { crew: ids };
  });
}

export async function scheduleJob(input: { actorUserId: string; orgId: string; jobId: string; scheduledFor: Date | null }): Promise<{ scheduledFor: string | null }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "job.schedule");
    const job = await readJobTx(tx, input.orgId, input.jobId);
    if (["done", "cancelled", "lost"].includes(job.status)) throw new JobTransitionError(job.status, job.status);
    const iso = input.scheduledFor ? input.scheduledFor.toISOString() : null;
    await putJob(tx, { ...job, scheduledFor: iso, updatedAt: new Date().toISOString() });
    await recordAudit(tx, {
      tenantId: input.orgId, actorType: "user", actorId: input.actorUserId,
      action: "job.schedule", target: `job:${job.id}`, tier: 0, outcome: "success",
      metadata: { scheduled: iso !== null },
    });
    return { scheduledFor: iso };
  });
}

/** booked → dispatched. The pack hard rule (dispatchRequiresApproval) is satisfied by the human manager click. */
export async function dispatchJob(input: { actorUserId: string; orgId: string; jobId: string }): Promise<{ status: JobStatus }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "job.dispatch");
    let job = await readJobTx(tx, input.orgId, input.jobId);
    if (job.status === "dispatched") return { status: job.status };
    if (job.status !== "booked") throw new JobTransitionError(job.status, "dispatched");
    if (!job.crew.length) throw new AppError("VALIDATION", "Assign at least one crew member before dispatching.");
    if (!job.scheduledFor) throw new AppError("VALIDATION", "Set a date before dispatching.");
    job = move(job, "dispatched");
    await putJob(tx, job);
    await recordAudit(tx, {
      tenantId: input.orgId, actorType: "user", actorId: input.actorUserId,
      action: "job.dispatch", target: `job:${job.id}`, tier: 1, outcome: "success",
      metadata: { crew: job.crew.length, scheduled: true },
    });
    return { status: job.status };
  });
}

/** Crew-visible progress: dispatched → in_progress → done. Members may advance; viewers may not. */
export async function advanceJob(input: { actorUserId: string; orgId: string; jobId: string; to: "in_progress" | "done" }): Promise<{ status: JobStatus }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "job.advance");
    let job = await readJobTx(tx, input.orgId, input.jobId);
    job = move(job, input.to);
    await putJob(tx, job);
    await recordAudit(tx, {
      tenantId: input.orgId, actorType: "user", actorId: input.actorUserId,
      action: "job.advance", target: `job:${job.id}`, tier: 1, outcome: "success",
      metadata: { to: input.to },
    });
    return { status: job.status };
  });
}

/** estimate_sent → booked | lost. */
export async function recordJobOutcome(input: { actorUserId: string; orgId: string; jobId: string; outcome: "booked" | "lost" }): Promise<{ status: JobStatus }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "job.outcome");
    let job = await readJobTx(tx, input.orgId, input.jobId);
    job = move(job, input.outcome);
    await putJob(tx, job);
    await recordAudit(tx, {
      tenantId: input.orgId, actorType: "user", actorId: input.actorUserId,
      action: "job.outcome", target: `job:${job.id}`, tier: 1, outcome: "success",
      metadata: { outcome: input.outcome },
    });
    return { status: job.status };
  });
}

export async function cancelJob(input: { actorUserId: string; orgId: string; jobId: string }): Promise<{ status: JobStatus }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "job.cancel");
    let job = await readJobTx(tx, input.orgId, input.jobId);
    job = move(job, "cancelled");
    await putJob(tx, job);
    await recordAudit(tx, {
      tenantId: input.orgId, actorType: "user", actorId: input.actorUserId,
      action: "job.cancel", target: `job:${job.id}`, tier: 1, outcome: "success",
      metadata: {},
    });
    return { status: job.status };
  });
}

/* ------------------------------------------------- estimate send (gated) */

/** Agent identity estimate-send tasks run under. Kind is constrained by the schema enum; the display name keeps it distinct from the front desk's agent. */
async function ensureJobsAgent(tx: Tx, tenantId: string): Promise<string> {
  const [existing] = await tx.select().from(agents).where(and(eq(agents.tenantId, tenantId), eq(agents.kind, "scheduling"), eq(agents.displayName, "Jobs")));
  if (existing) return existing.id;
  const [row] = await tx.insert(agents).values({ tenantId, kind: "scheduling", displayName: "Jobs", status: "active" }).returning({ id: agents.id });
  return row!.id;
}

/**
 * Sends never go direct: this moves the job to approval_pending and files a
 * task + approval request whose single step is the jobs.send_estimate tool at
 * the pack's compliance floor. Only a human approval on the Approvals page
 * releases the send. Fails closed while the engine reports blockers (example
 * prices, missing business fields, bad intake).
 */
export async function requestEstimateSend(input: { actorUserId: string; orgId: string; jobId: string }): Promise<{ approvalId: string; tier: number }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "job.send_estimate");
    const { packId, pack } = await requireElitePack(tx);
    const cfg = await readConfigTx(tx, input.orgId);
    let job = await readJobTx(tx, input.orgId, input.jobId);
    if (!job.customerEmail) throw new AppError("VALIDATION", "Add the customer's email before sending an estimate.");
    const estimate = buildEstimate(pack, job.answers, estimateConfigFor(job, cfg));
    if (estimate.blockedReasons.length) {
      throw new AppError("CONFLICT", `This estimate cannot be sent yet: ${estimate.blockedReasons.join(" ")}`);
    }
    const tier = Math.min(4, Math.max(2, pack.compliance.approvalFloors["send_estimate"] ?? 2, estimate.approvalTier)) as 2 | 3 | 4;

    const agentId = await ensureJobsAgent(tx, input.orgId);
    const taskId = randomUUID();
    // Same formula the executor re-checks — a custom hash here caused DIGEST_MISMATCH on approve.
    const digest = actionDigest({ tenantId: input.orgId, taskId, agentId, step: 0, tool: "jobs.send_estimate", args: { jobId: job.id } });
    await tx.insert(tasks).values({
      id: taskId,
      tenantId: input.orgId,
      requestedBy: input.actorUserId,
      assignedAgentId: agentId,
      intent: `Send the estimate for job ${job.id}`,
      title: `Send estimate · ${job.customerName.slice(0, 60)}`,
      state: "WAITING_FOR_APPROVAL",
      input: { source: "jobs", jobId: job.id },
      plan: {
        steps: [
          {
            index: 0,
            tool: "jobs.send_estimate",
            args: { jobId: job.id },
            tier,
            decision: "needs_approval",
            summary: `Email the estimate for job ${job.id.slice(0, 8)} (${estimate.totalCents} cents) to the customer`,
            digest,
          },
        ],
      },
    });
    const [approval] = await tx
      .insert(approvalRequests)
      .values({
        tenantId: input.orgId,
        taskId,
        agentId,
        toolName: "jobs.send_estimate",
        tier,
        actionDigest: digest,
        payload: { tool: "jobs.send_estimate", args: { jobId: job.id }, step: 0, source: "jobs" },
        summary: `Send estimate for job ${job.id.slice(0, 8)} to the customer`,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: approvalRequests.id });

    job = move(job, "approval_pending");
    await putJob(tx, job);
    await recordAudit(tx, {
      tenantId: input.orgId, actorType: "user", actorId: input.actorUserId,
      action: "job.send_estimate.requested", target: `job:${job.id}`, tier, outcome: "success",
      approvalRequestId: approval!.id,
      metadata: { packId, totalCents: estimate.totalCents },
    });
    return { approvalId: approval!.id, tier };
  });
}

/** A rejected or withdrawn send goes back to draft so it can be edited and re-sent. */
export async function returnEstimateToDraft(input: { actorUserId: string; orgId: string; jobId: string }): Promise<{ status: JobStatus }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "job.return_draft");
    let job = await readJobTx(tx, input.orgId, input.jobId);
    job = move(job, "estimate_ready");
    await putJob(tx, job);
    return { status: job.status };
  });
}

/**
 * Called by the jobs.send_estimate tool after the approval clears — inside the
 * executor's tenant scope, so RLS applies here too. Idempotent: a re-run after
 * a crash sees estimate_sent and exits quietly.
 */
export async function markEstimateSent(tx: Tx, tenantId: string, jobId: string): Promise<{ job: JobRecord; already: boolean }> {
  const job = await readJobTx(tx, tenantId, jobId);
  if (job.status === "estimate_sent") return { job, already: true };
  const moved = move(job, "estimate_sent");
  await putJob(tx, { ...moved, sentAt: new Date().toISOString() });
  return { job: moved, already: false };
}

/** Load a job + its live estimate for the send tool. Throws NOT_FOUND outside the tenant. */
export async function jobForSend(tx: Tx, tenantId: string, jobId: string): Promise<{ job: JobRecord; pack: ElitePack; estimate: Estimate; business: string | null }> {
  const { pack } = await requireElitePack(tx);
  const cfg = await readConfigTx(tx, tenantId);
  const job = await readJobTx(tx, tenantId, jobId);
  const estimate = buildEstimate(pack, job.answers, estimateConfigFor(job, cfg));
  return { job, pack, estimate, business: cfg.businessFields["business_address"] ?? null };
}
