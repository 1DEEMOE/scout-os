import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, routineRuns, routines, withTenant } from "@wos/db";
import {
  AppError,
  BRIEFING_SOURCES,
  briefingSourceLabel,
  createOrg,
  createRoutine,
  executeRoutineRun,
  getRoutine,
  latestBriefing,
  listRoutines,
  nextRunAfter,
  operatorSetPlan,
  routeRoutineStep,
  runRoutineNow,
  runTask,
  setAgentsPaused,
  setRoutinePaused,
  stopBoss,
  validateSchedule,
  zonedToUtc,
  type Briefing,
  type RoutineRunJob,
} from "../src/index";
import { ownerQuery, seedUser } from "../../db/test/helpers";
import { approvalsFor, auditActions, setupHarness, taskRow, type Harness } from "./engine-helpers";

afterAll(async () => {
  await stopBoss();
  await closePool();
});

const iso = (s: string) => new Date(s).toISOString();
const daily = [0, 1, 2, 3, 4, 5, 6];

describe("schedule: IANA time zones and DST", () => {
  it("America/New_York: 07:00 stays 07:00 local across spring-forward (UTC offset changes)", () => {
    const s = { hour: 7, minute: 0, daysOfWeek: daily, timezone: "America/New_York" };
    expect(nextRunAfter(s, new Date("2026-03-07T00:00:00Z")).toISOString()).toBe(iso("2026-03-07T12:00:00Z")); // EST −5
    expect(nextRunAfter(s, new Date("2026-03-07T12:00:00Z")).toISOString()).toBe(iso("2026-03-08T11:00:00Z")); // EDT −4
  });
  it("America/New_York: 07:00 stays 07:00 local across fall-back", () => {
    const s = { hour: 7, minute: 0, daysOfWeek: daily, timezone: "America/New_York" };
    expect(nextRunAfter(s, new Date("2026-10-31T11:00:00Z")).toISOString()).toBe(iso("2026-11-01T12:00:00Z"));
  });
  it("a time inside the spring-forward gap runs just after the gap (02:30 → 03:30 EDT)", () => {
    const s = { hour: 2, minute: 30, daysOfWeek: daily, timezone: "America/New_York" };
    expect(nextRunAfter(s, new Date("2026-03-08T05:00:00Z")).toISOString()).toBe(iso("2026-03-08T07:30:00Z"));
  });
  it("a time that happens twice at fall-back runs once, at the first occurrence", () => {
    const s = { hour: 1, minute: 30, daysOfWeek: daily, timezone: "America/New_York" };
    const first = nextRunAfter(s, new Date("2026-11-01T04:00:00Z"));
    expect(first.toISOString()).toBe(iso("2026-11-01T05:30:00Z")); // 01:30 EDT
    // The second 01:30 (EST, 06:30Z) is skipped: the next run is the following day.
    expect(nextRunAfter(s, first).toISOString()).toBe(iso("2026-11-02T06:30:00Z"));
  });
  it("southern hemisphere (Australia/Sydney) DST end", () => {
    const s = { hour: 7, minute: 0, daysOfWeek: daily, timezone: "Australia/Sydney" };
    expect(nextRunAfter(s, new Date("2026-04-03T00:00:00Z")).toISOString()).toBe(iso("2026-04-03T20:00:00Z")); // AEDT +11
    expect(nextRunAfter(s, new Date("2026-04-03T20:00:00Z")).toISOString()).toBe(iso("2026-04-04T21:00:00Z")); // AEST +10
  });
  it("zones without DST and with half-hour offsets", () => {
    expect(zonedToUtc(2026, 3, 8, 7, 0, "Asia/Kolkata").toISOString()).toBe(iso("2026-03-08T01:30:00Z"));
    expect(zonedToUtc(2026, 7, 1, 7, 0, "UTC").toISOString()).toBe(iso("2026-07-01T07:00:00Z"));
  });
  it("weekday schedules skip the weekend in local time, not UTC", () => {
    const s = { hour: 7, minute: 0, daysOfWeek: [1, 2, 3, 4, 5], timezone: "America/New_York" };
    // Friday 2026-11-06 23:30 EST is already Saturday in UTC; next is Monday 07:00 local.
    expect(nextRunAfter(s, new Date("2026-11-07T04:30:00Z")).toISOString()).toBe(iso("2026-11-09T12:00:00Z"));
  });
  it("rejects bad schedules", () => {
    expect(validateSchedule({ hour: 7, minute: 0, daysOfWeek: daily, timezone: "Mars/Olympus" })).toMatch(/Unknown time zone/);
    expect(validateSchedule({ hour: 24, minute: 0, daysOfWeek: daily, timezone: "UTC" })).toMatch(/Hour/);
    expect(validateSchedule({ hour: 7, minute: 0, daysOfWeek: [], timezone: "UTC" })).toMatch(/day/);
    expect(validateSchedule({ hour: 7, minute: 0, daysOfWeek: [7], timezone: "UTC" })).toMatch(/day/);
  });
});

let h: Harness;
const NOW = new Date("2026-11-05T11:00:00Z"); // 06:00 EST

async function newRoutine(orgId = h.orgId) {
  return createRoutine({ actorUserId: "owner", orgId, kind: "morning_briefing", name: "Morning briefing", hour: 7, minute: 0, daysOfWeek: daily, timezone: "America/New_York", now: NOW });
}
function jobFor(r: { id: string; tenantId: string; nextRunAt: Date | null }): RoutineRunJob {
  return { tenantId: r.tenantId, routineId: r.id, scheduledFor: r.nextRunAt!.toISOString(), trigger: "schedule" };
}
const at = (d: Date) => () => d;
async function runsOf(orgId: string) {
  return withTenant(orgId, (tx) => tx.select().from(routineRuns));
}
async function routineOf(orgId: string, id: string) {
  return withTenant(orgId, async (tx) => (await tx.select().from(routines).where(eq(routines.id, id)))[0]!);
}
async function routineRunsUsed(orgId: string): Promise<number> {
  const r = await withTenant(orgId, (tx) => tx.execute(sql`SELECT coalesce(sum(used), 0)::int AS n FROM usage_counters WHERE metric = 'routine.runs'`));
  return (r.rows[0] as { n: number }).n;
}
async function queuedJobs(routineId: string) {
  return ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'routine.run' AND data->>'routineId' = $1 AND state IN ('created','retry')`, [routineId]);
}

describe("routines: define, schedule, run", () => {
  beforeEach(async () => {
    h = await setupHarness();
  });

  it("creates a routine (managers only), computes next run in its time zone, and queues it", async () => {
    await expect(createRoutine({ actorUserId: "member", orgId: h.orgId, kind: "morning_briefing", name: "x", hour: 7, minute: 0, daysOfWeek: daily, timezone: "UTC" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createRoutine({ actorUserId: "owner", orgId: h.orgId, kind: "morning_briefing", name: "x", hour: 7, minute: 0, daysOfWeek: daily, timezone: "Nope/Zone" })).rejects.toMatchObject({ code: "VALIDATION" });
    const r = await newRoutine();
    expect(r.nextRunAt!.toISOString()).toBe(iso("2026-11-05T12:00:00Z"));
    expect(r.maxTier).toBe(0);
    expect((await queuedJobs(r.id))[0]!.n).toBe(1);
    expect((await listRoutines({ actorUserId: "viewer", orgId: h.orgId }))).toHaveLength(1);
    expect((await auditActions(h.orgId)).some((a) => a.action === "routine.create" && a.outcome === "success")).toBe(true);
  });

  it("runs the briefing read-only, records the sources, advances and re-queues the schedule", async () => {
    const r = await newRoutine();
    const auditsBefore = (await auditActions(h.orgId)).length;
    const out = await executeRoutineRun(jobFor(r), { now: at(new Date("2026-11-05T12:00:05Z")) });
    expect(out.status).toBe("succeeded");
    const [run] = await runsOf(h.orgId);
    expect(run!.status).toBe("succeeded");
    expect(run!.sources.map((s) => s.source)).toEqual(expect.arrayContaining(["conversations_unanswered", "crm_records_stalled", "invoices_overdue", "approval_requests_pending"]));
    const b = run!.output as Briefing;
    expect(b.sections.map((s) => s.key)).toEqual(["storm_signals", "unanswered_leads", "stalled_deals", "follow_ups_due", "overdue_invoices", "pending_approvals", "ai_visibility"]);
    expect(b.maxTierUsed).toBe(0);
    // Starter plan: Scout section says why it's empty instead of showing 0.
    expect(b.sections[0]).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/isn't included in the Starter plan/) });
    const after = await routineOf(h.orgId, r.id);
    expect(after.nextRunAt!.toISOString()).toBe(iso("2026-11-06T12:00:00Z"));
    expect((await queuedJobs(r.id))[0]!.n).toBe(2);
    // Only tier-0 audit for the run itself; no task was created (nothing executed beyond reads).
    const audits = (await auditActions(h.orgId)).slice(auditsBefore);
    expect(audits.map((a) => a.action)).toEqual(["routine.run"]);
    expect(await withTenant(h.orgId, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM tasks`)).then((x) => x.rows[0])).toEqual({ n: 0 });
    expect((await latestBriefing({ actorUserId: "viewer", orgId: h.orgId }))?.run.id).toBe(run!.id);
  });

  it("fills sections from real data: unanswered lead, stalled deal, overdue invoice, pending approval", async () => {
    await withTenant(h.orgId, async (tx) => {
      const one = async (q: ReturnType<typeof sql>) => (await tx.execute(q)).rows[0] as Record<string, string>;
      const conn = await one(sql`INSERT INTO integration_connections (tenant_id, provider, account_label, secret_ref, secret_ciphertext, created_by) VALUES (${h.orgId}, 'google', 'a@mail.test', 'v1', 'x', 'owner') RETURNING id`);
      const ident = await one(sql`INSERT INTO email_identities (tenant_id, integration_connection_id, address) VALUES (${h.orgId}, ${conn.id}, 'a@mail.test') RETURNING id`);
      const lead = await one(sql`INSERT INTO conversations (tenant_id, email_identity_id, subject, external_thread_id, category, last_message_at) VALUES (${h.orgId}, ${ident.id}, 'Roof quote?', 't1', 'lead', '2026-11-03T15:00Z') RETURNING id`);
      await tx.execute(sql`INSERT INTO messages (tenant_id, conversation_id, direction, sender, external_id, sent_at) VALUES (${h.orgId}, ${lead.id}, 'inbound', 'x@y.test', 'm1', '2026-11-03T15:00Z')`);
      const answered = await one(sql`INSERT INTO conversations (tenant_id, email_identity_id, subject, external_thread_id, category) VALUES (${h.orgId}, ${ident.id}, 'Answered', 't2', 'lead') RETURNING id`);
      await tx.execute(sql`INSERT INTO messages (tenant_id, conversation_id, direction, sender, external_id, sent_at) VALUES (${h.orgId}, ${answered.id}, 'inbound', 'x@y.test', 'm2', '2026-11-03T15:00Z'), (${h.orgId}, ${answered.id}, 'outbound', 'me', 'm3', '2026-11-03T16:00Z')`);
      const c = await one(sql`INSERT INTO contacts (tenant_id, name, email) VALUES (${h.orgId}, 'Pat', 'pat@lead.test') RETURNING id`);
      await tx.execute(sql`INSERT INTO crm_records (tenant_id, contact_id, provider, external_id, name, stage, synced_at) VALUES (${h.orgId}, ${c.id}, 'fake', 'd1', 'Old deal', 'proposal', '2026-10-01Z'), (${h.orgId}, ${c.id}, 'fake', 'd2', 'Won deal', 'closedwon', '2026-10-01Z')`);
      await tx.execute(sql`INSERT INTO invoices (tenant_id, contact_id, provider, external_id, number, customer_name, status, amount_due_cents, due_date) VALUES
        (${h.orgId}, ${c.id}, 'fake', 'i1', 'INV-1', 'Pat', 'open', 120000, '2026-10-20'),
        (${h.orgId}, ${c.id}, 'fake', 'i2', 'INV-2', 'Pat', 'open', 5000, '2026-12-20'),
        (${h.orgId}, ${c.id}, 'fake', 'i3', 'INV-3', 'Pat', 'paid', 5000, '2026-10-01')`);
    });
    h.setPlan([{ name: "mock.send_email", input: { to: "a@b.test", subject: "s", body: "b" } }]);
    const { taskId } = await (await import("../src/index")).createTask({ actorUserId: "owner", orgId: h.orgId, intent: "email them" });
    expect(await runTask(h.orgId, taskId)).toBe("WAITING_FOR_APPROVAL");

    const r = await newRoutine();
    await executeRoutineRun(jobFor(r), { now: at(new Date("2026-11-05T12:00:05Z")) });
    const b = (await runsOf(h.orgId))[0]!.output as Briefing;
    const sec = Object.fromEntries(b.sections.map((s) => [s.key, s]));
    expect(sec.unanswered_leads).toMatchObject({ count: 1, items: [{ label: "Roof quote?" }] });
    expect(sec.stalled_deals).toMatchObject({ count: 1, items: [{ label: "Old deal" }] });
    expect(sec.overdue_invoices).toMatchObject({ count: 1, items: [{ label: "INV-1 · Pat", detail: "$1,200.00 due 2026-10-20" }] });
    expect(sec.pending_approvals!.count).toBe(1);
    // In-app only: nothing was sent while building it.
    expect(h.ledger.effects.size).toBe(0);
  });

  it("Scout section: unavailable until the profile is reviewed, then lists signals and scored prospects", async () => {
    await operatorSetPlan(h.orgId, "scout_pro", "test");
    const r = await newRoutine();
    await executeRoutineRun(jobFor(r), { now: at(new Date("2026-11-05T12:00:05Z")) });
    let b = (await runsOf(h.orgId))[0]!.output as Briefing;
    expect(b.sections[0]).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/profile hasn't been reviewed/) });

    await withTenant(h.orgId, async (tx) => {
      const one = async (q: ReturnType<typeof sql>) => (await tx.execute(q)).rows[0] as Record<string, string>;
      await tx.execute(sql`INSERT INTO business_profiles (tenant_id, vertical, updated_by, status, reviewed_by, reviewed_at) VALUES (${h.orgId}, 'roofing', 'owner', 'reviewed', 'owner', now())`);
      const src = await one(sql`INSERT INTO intelligence_sources (tenant_id, kind, label, usage_rights, created_by) VALUES (${h.orgId}, 'noaa_spc_storm_reports', 'SPC', 'public domain', 'owner') RETURNING id`);
      const sig = await one(sql`INSERT INTO signal_observations (tenant_id, source_id, kind, event_at, location, county, state, confidence, limitations, external_ref)
        VALUES (${h.orgId}, ${src.id}, 'hail', '2026-11-04T20:00Z', 'Town', 'County', 'TX', 'preliminary', 'none', 'r1') RETURNING id`);
      const p = await one(sql`INSERT INTO prospects (tenant_id, source_id, name, city, state, dedupe_key, retention_until) VALUES (${h.orgId}, ${src.id}, 'Owner', 'Plano', 'TX', 'dk', now() + interval '1 year') RETURNING id`);
      await tx.execute(sql`INSERT INTO opportunities (tenant_id, prospect_id, vertical, score, score_breakdown, explanation, signal_ids) VALUES (${h.orgId}, ${p.id}, 'roofing', 81, '{}', '{}', ARRAY[${sig.id}]::uuid[])`);
    });
    const r2 = await routineOf(h.orgId, r.id);
    await executeRoutineRun(jobFor(r2), { now: at(new Date("2026-11-06T12:00:05Z")) });
    const run = (await getRoutine({ actorUserId: "owner", orgId: h.orgId, routineId: r.id })).runs[0]!;
    b = run.output as Briefing;
    expect(b.sections[0]).toMatchObject({ status: "ok", count: 2 });
    expect(b.sections[0]!.items.map((i) => i.label)).toEqual(["1 hail report in the last 7 days", "Score 81 · Owner · Plano, TX"]);
    expect(run.sources.map((s) => s.source)).toEqual(expect.arrayContaining(["business_profiles", "signal_observations", "opportunities_scored"]));
    expect(b.sections[0]!.sources.map(briefingSourceLabel)).toEqual(["Business profile", "Storm reports", "Scored leads"]);
  });

  it("maps briefing source keys to plain labels", () => {
    expect(briefingSourceLabel("invoices_overdue")).toBe("Overdue invoices");
    expect(briefingSourceLabel("approval_requests_pending")).toBe("Waiting approvals");
    expect(briefingSourceLabel("unknown_source_key")).toBe("unknown source key");
  });

  it("fails loudly when a source can't be read: names it, stores no partial briefing, audits the error", async () => {
    const r = await newRoutine();
    const readers = { ...BRIEFING_SOURCES, invoices_overdue: async () => { throw new Error('relation "invoices" is unreadable'); } };
    const out = await executeRoutineRun(jobFor(r), { now: at(new Date("2026-11-05T12:00:05Z")), readers });
    expect(out).toMatchObject({ status: "failed", error: expect.stringMatching(/Briefing source "invoices_overdue" could not be read/) });
    const [run] = await runsOf(h.orgId);
    expect(run).toMatchObject({ status: "failed", output: null });
    expect(run!.sources.find((s) => s.source === "invoices_overdue")?.rows).toBe(-1);
    expect(run!.sources.find((s) => s.source === "conversations_unanswered")?.rows).toBe(0);
    expect((await auditActions(h.orgId)).find((a) => a.action === "routine.run")).toMatchObject({ outcome: "error", metadata: { reason: "missing_source", source: "invoices_overdue" } });
    // A failed morning doesn't stop tomorrow's.
    expect((await routineOf(h.orgId, r.id)).nextRunAt!.toISOString()).toBe(iso("2026-11-06T12:00:00Z"));
    expect(await latestBriefing({ actorUserId: "owner", orgId: h.orgId })).toBeNull();
  });

  it("a real SQL error in a source also fails the run (not swallowed)", async () => {
    const r = await newRoutine();
    const readers = { ...BRIEFING_SOURCES, crm_records_stalled: async ({ tx }: { tx: Parameters<typeof withTenant>[1] extends (t: infer T) => unknown ? T : never }) => (await tx.execute(sql`SELECT no_such_column FROM crm_records`)).rows };
    const out = await executeRoutineRun(jobFor(r), { now: at(new Date("2026-11-05T12:00:05Z")), readers: readers as typeof BRIEFING_SOURCES });
    expect(out).toMatchObject({ status: "failed", error: expect.stringMatching(/crm_records_stalled.*no_such_column/) });
  });
});

describe("routines: idempotency", () => {
  beforeEach(async () => {
    h = await setupHarness();
  });

  it("a redelivered scheduled job runs once", async () => {
    const r = await newRoutine();
    const job = jobFor(r);
    expect((await executeRoutineRun(job, { now: at(new Date("2026-11-05T12:00:05Z")) })).status).toBe("succeeded");
    expect((await executeRoutineRun(job, { now: at(new Date("2026-11-05T12:00:09Z")) })).status).toBe("stale");
    expect(await runsOf(h.orgId)).toHaveLength(1);
    expect(await routineRunsUsed(h.orgId)).toBe(1);
  });

  it("two workers racing on the same job produce one run", async () => {
    const r = await newRoutine();
    const outs = await Promise.all([executeRoutineRun(jobFor(r)), executeRoutineRun(jobFor(r)), executeRoutineRun(jobFor(r))]);
    expect(outs.filter((o) => o.status === "succeeded")).toHaveLength(1);
    expect(await runsOf(h.orgId)).toHaveLength(1);
  });

  it("the same manual request (double click) is stored once", async () => {
    const r = await newRoutine();
    const job: RoutineRunJob = { tenantId: h.orgId, routineId: r.id, scheduledFor: NOW.toISOString(), trigger: "manual", clientRef: "abcdef123456" };
    expect((await executeRoutineRun(job)).status).toBe("succeeded");
    expect((await executeRoutineRun(job)).status).toBe("duplicate");
    expect(await runsOf(h.orgId)).toHaveLength(1);
    // Manual runs don't move the schedule.
    expect((await routineOf(h.orgId, r.id)).nextRunAt!.toISOString()).toBe(r.nextRunAt!.toISOString());
  });

  it("a job for a paused or rescheduled routine does nothing", async () => {
    const r = await newRoutine();
    await setRoutinePaused({ actorUserId: "admin", orgId: h.orgId, routineId: r.id, paused: true });
    expect((await executeRoutineRun(jobFor(r))).status).toBe("stale");
    await setRoutinePaused({ actorUserId: "admin", orgId: h.orgId, routineId: r.id, paused: false, now: new Date("2026-11-05T13:00:00Z") });
    expect((await executeRoutineRun(jobFor(r))).status).toBe("stale"); // old instant
    const fresh = await routineOf(h.orgId, r.id);
    expect(fresh.nextRunAt!.toISOString()).toBe(iso("2026-11-06T12:00:00Z"));
    expect((await executeRoutineRun(jobFor(fresh))).status).toBe("succeeded");
    expect(await runsOf(h.orgId)).toHaveLength(1);
  });
});

describe("routines: kill switch, plan caps, roles", () => {
  beforeEach(async () => {
    h = await setupHarness();
  });

  it("pause-all-agents: scheduled runs are recorded as skipped, read nothing, use no quota; Run now is refused", async () => {
    const r = await newRoutine();
    await setAgentsPaused({ actorUserId: "owner", orgId: h.orgId, paused: true });
    const out = await executeRoutineRun(jobFor(r));
    expect(out).toMatchObject({ status: "skipped", reason: "agents_paused" });
    const [run] = await runsOf(h.orgId);
    expect(run).toMatchObject({ status: "skipped", skipReason: "agents_paused", sources: [], output: null });
    expect(await routineRunsUsed(h.orgId)).toBe(0);
    await expect(runRoutineNow({ actorUserId: "owner", orgId: h.orgId, routineId: r.id, clientRef: "abcdef123456" })).rejects.toMatchObject({ code: "CONFLICT" });
    // Schedule continues: tomorrow is still queued, and runs once agents resume.
    const next = await routineOf(h.orgId, r.id);
    expect(next.nextRunAt!.toISOString()).toBe(iso("2026-11-06T12:00:00Z"));
    await setAgentsPaused({ actorUserId: "owner", orgId: h.orgId, paused: false });
    expect((await executeRoutineRun(jobFor(next))).status).toBe("succeeded");
  });

  it("monthly run cap: a run past the plan's routine.runs is skipped (row kept), not executed", async () => {
    const r = await newRoutine();
    const period = new Date().toISOString().slice(0, 7);
    await withTenant(h.orgId, (tx) => tx.execute(sql`INSERT INTO usage_counters (tenant_id, metric, period, used) VALUES (${h.orgId}, 'routine.runs', ${period}, 62)`));
    const out = await executeRoutineRun(jobFor(r));
    expect(out).toMatchObject({ status: "skipped", reason: "quota_exceeded" });
    const [run] = await runsOf(h.orgId);
    expect(run).toMatchObject({ status: "skipped", skipReason: "quota_exceeded", output: null });
    expect(run!.error).toMatch(/62 routine runs/);
    expect((await auditActions(h.orgId)).filter((a) => a.action === "routine.run").map((a) => a.outcome)).toContain("denied");
  });

  it("active routine cap per plan (Starter: 1); paused routines don't count; resuming re-checks", async () => {
    const r = await newRoutine();
    await expect(newRoutine()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await setRoutinePaused({ actorUserId: "owner", orgId: h.orgId, routineId: r.id, paused: true });
    await newRoutine();
    await expect(setRoutinePaused({ actorUserId: "owner", orgId: h.orgId, routineId: r.id, paused: false })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("only owners/admins manage routines; viewers can read", async () => {
    const r = await newRoutine();
    for (const who of ["member", "viewer"]) {
      await expect(setRoutinePaused({ actorUserId: who, orgId: h.orgId, routineId: r.id, paused: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(runRoutineNow({ actorUserId: who, orgId: h.orgId, routineId: r.id, clientRef: "abcdef123456" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(getRoutine({ actorUserId: "viewer", orgId: h.orgId, routineId: r.id })).resolves.toBeTruthy();
    await expect(runRoutineNow({ actorUserId: "admin", orgId: h.orgId, routineId: r.id, clientRef: "bad" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("routines: tier enforcement", () => {
  beforeEach(async () => {
    h = await setupHarness();
  });

  it("the database refuses a routine above tier 1", async () => {
    const r = await newRoutine();
    await expect(withTenant(h.orgId, (tx) => tx.update(routines).set({ maxTier: 2 }).where(eq(routines.id, r.id)))).rejects.toThrow();
  });

  it("tier 0 steps run inline; a tier 1 step above the routine's max goes to a task", async () => {
    const r = await newRoutine();
    await withTenant(h.orgId, async (tx) => {
      expect(await routeRoutineStep(tx, r, { tool: "mock.lookup", args: {}, tier: 0 })).toEqual({ mode: "inline" });
      expect((await routeRoutineStep(tx, r, { tool: "mock.note", args: { text: "x" }, tier: 1, agentKind: "inbox" })).mode).toBe("approval_task");
    });
  });

  it("tier 2+ steps are never executed by the routine: they become tasks and the engine's unchanged policy asks for approval", async () => {
    const r = await newRoutine();
    await withTenant(h.orgId, (tx) => tx.update(routines).set({ maxTier: 1 }).where(eq(routines.id, r.id)));
    const r1 = await routineOf(h.orgId, r.id);
    const send = await withTenant(h.orgId, (tx) => routeRoutineStep(tx, r1, { tool: "mock.send_email", args: { to: "a@b.test", subject: "s", body: "b" }, tier: 2, agentKind: "inbox" }));
    // Even a step that claims a low tier is re-tiered by the engine from the tool registry.
    const lying = await withTenant(h.orgId, (tx) => routeRoutineStep(tx, r1, { tool: "mock.delete_contact", args: { contactId: "c1" }, tier: 9, agentKind: "inbox" }));
    if (send.mode !== "approval_task" || lying.mode !== "approval_task") throw new Error("expected approval tasks");
    expect(h.ledger.effects.size).toBe(0);
    expect(await runTask(h.orgId, send.taskId)).toBe("WAITING_FOR_APPROVAL");
    expect(await runTask(h.orgId, lying.taskId)).toBe("WAITING_FOR_APPROVAL");
    const [a2] = await approvalsFor(h.orgId, send.taskId);
    const [a4] = await approvalsFor(h.orgId, lying.taskId);
    expect(a2).toMatchObject({ tier: 2, status: "pending" });
    expect(a4).toMatchObject({ tier: 4, status: "pending" });
    expect(h.ledger.effects.size).toBe(0);
    expect((await taskRow(h.orgId, send.taskId)).input).toMatchObject({ routineId: r.id });
  });

  it("a declared tier can't loosen policy: a tier-2 tool declared as tier 0 runs 'inline' only in the routine's own code, never as a tool call", async () => {
    // routeRoutineStep only *decides*; routines have no code path that calls tools.
    // The briefing (the only R1 routine) is pure SELECTs, verified by the ledger staying empty.
    const r = await newRoutine();
    await executeRoutineRun(jobFor(r));
    expect(h.ledger.effects.size).toBe(0);
  });
});

describe("routines: tenant isolation", () => {
  beforeEach(async () => {
    h = await setupHarness();
  });

  it("another org can't see, run or pause this org's routine, and a forged job does nothing", async () => {
    const r = await newRoutine();
    await executeRoutineRun(jobFor(r));
    await seedUser("other", "other@example.test");
    const { orgId: B } = await createOrg({ actorUserId: "other", name: "Other Co" });
    await expect(getRoutine({ actorUserId: "other", orgId: B, routineId: r.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(setRoutinePaused({ actorUserId: "other", orgId: B, routineId: r.id, paused: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(runRoutineNow({ actorUserId: "other", orgId: B, routineId: r.id, clientRef: "abcdef123456" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getRoutine({ actorUserId: "other", orgId: h.orgId, routineId: r.id })).rejects.toBeInstanceOf(AppError);
    expect(await listRoutines({ actorUserId: "other", orgId: B })).toHaveLength(0);
    expect(await latestBriefing({ actorUserId: "other", orgId: B })).toBeNull();
    expect((await executeRoutineRun({ ...jobFor(r), tenantId: B })).status).toBe("stale");
    expect(await runsOf(B)).toHaveLength(0);
    expect(await runsOf(h.orgId)).toHaveLength(1);
  });
});
