import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvalRequests, closePool, invoices, routines, tasks, withTenant } from "@wos/db";
import {
  activityFeed,
  approvalCard,
  approvalExpiryMs,
  artifactLinkOpen,
  batchNotifications,
  classifyUrgency,
  configureEngine,
  createAgent,
  createOrg,
  createTask,
  deliverNotifications,
  denyStopsRetry,
  feedGroupKey,
  firstRunFor,
  firstRunScript,
  handBack,
  ingestLead,
  listArtifacts,
  memoryTools,
  MockLedger,
  mockTools,
  moneyDigest,
  moneySnapshot,
  MockModelProvider,
  ModelRouter,
  opportunityCardsForPack,
  parseChatRoutine,
  parseForget,
  pauseTask,
  readArtifactByToken,
  produceIntegration,
  recordAudit,
  registerIntegrationHandlers,
  replayDeadLetter,
  resetAppliedEffects,
  runEvent,
  runTask,
  saveArtifact,
  saveChatRoutine,
  saveMoneyCap,
  saveNotifyPrefs,
  saveSuggestedRule,
  chipsForTask,
  startChipAction,
  takeOverDraft,
  setIntegrationJournal,
  stopBoss,
  ToolRegistry,
  undoPracticeMemory,
  withinQuietHours,
  auditJournal,
  listDeadLetters,
} from "../src/index";
import { rememberMockRetry, resetMockRetries, runMockRetry } from "../src/events/retry";
import { resetDb, seedUser } from "../../db/test/helpers";

describe("approval cards", () => {
  it("names warnings and refuses always-allow for customer, money, and irreversible actions", () => {
    expect(approvalCard({ summary: "Email Ada the quote", tier: 2, toolName: "inbox.send_draft" }).badges).toContain("goes to a customer");
    expect(approvalCard({ summary: "Email Ada the quote", tier: 2, toolName: "inbox.send_draft" }).alwaysAllowBlocked).toMatch(/can't become an automatic rule/);
    expect(approvalCard({ summary: "Pay the vendor", tier: 3, toolName: "finance.create_invoice" }).badges).toContain("money");
    expect(approvalCard({ summary: "Delete the contact", tier: 4, toolName: "mock.delete_contact" }).badges).toContain("can't be undone");
    expect(approvalCard({ summary: "Note the gate code", tier: 1, toolName: "memory.note" }).alwaysAllowBlocked).toBeNull();
    expect(denyStopsRetry()).toBe(true);
  });

  it("expires background cards inside 30 to 60 minutes and leaves a person's request alone", () => {
    expect(approvalExpiryMs("system:speed-to-lead", 45)).toBe(45 * 60 * 1000);
    expect(approvalExpiryMs("routine:brief", 5)).toBe(30 * 60 * 1000);
    expect(approvalExpiryMs("routine:brief", 90)).toBe(60 * 60 * 1000);
    expect(approvalExpiryMs("owner-user", 45, 86_400_000)).toBe(86_400_000);
  });
});

describe("rules, routines, opportunities, notifications", () => {
  beforeEach(async () => {
    await resetDb();
    await seedUser("owner", "owner@example.test");
    configureEngine({ router: new ModelRouter([new MockModelProvider(() => ({}))], "mock"), tools: new ToolRegistry().register(...memoryTools(), ...mockTools(new MockLedger())) });
  });
  afterAll(async () => {
    await stopBoss();
    await closePool();
  });

  it("will not save an always-allow rule for tier 2 or money", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Rules Co" });
    await expect(saveSuggestedRule({ actorUserId: "owner", orgId, text: "Always email new leads", toolName: "mock.send_email" })).rejects.toThrow(/automatic rule|person|isn't available/);
    const saved = await saveSuggestedRule({ actorUserId: "owner", orgId, text: "Keep notes short", toolName: "memory.note" });
    expect(saved.tier).toBe(1);
  });

  it("confirms a Friday routine without letting it send or pay", async () => {
    const friday = parseChatRoutine("every Friday text next week's customers");
    expect("plain" in friday && friday.plain).toMatch(/needs your OK/);
    expect("sends" in parseChatRoutine("every Friday text next week's customers")).toBe(false);
    expect(parseChatRoutine("every Friday pay the vendors")).toEqual({ refused: expect.stringMatching(/money|undone/) });
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Routine Co" });
    const saved = await saveChatRoutine({ actorUserId: "owner", orgId, text: "every Friday, list next week's customers" });
    expect(saved.maxTier).toBeLessThanOrEqual(1);
    expect(saved.sends).toBe(false);
    expect(saved.scheduled).toBe(true);
    const [row] = await withTenant(orgId, (tx) => tx.select().from(routines));
    expect(row?.id).toBe(saved.id);
    expect(row?.kind).toBe("morning_briefing");
    expect(row?.maxTier).toBeLessThanOrEqual(1);
    expect(row?.nextRunAt).toBeInstanceOf(Date);
    expect(row?.status).toBe("active");
  });

  it("hashes activity grouping keys so an email or provider key cannot appear", async () => {
    const raw = "client@example.test sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const key = feedGroupKey(raw);
    expect(key).toMatch(/^job:[0-9a-f]{12}$/);
    expect(key).not.toMatch(/example\.test|sk-ant/);
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Feed Co" });
    await withTenant(orgId, (tx) => recordAudit(tx, {
      tenantId: orgId,
      actorType: "user",
      actorId: "owner",
      action: "task.create",
      target: raw,
      tier: 1,
      outcome: "success",
      metadata: { taskId: raw },
    }));
    const feed = await activityFeed({ actorUserId: "owner", orgId });
    expect(JSON.stringify(feed)).not.toMatch(/example\.test|sk-ant/);
    expect(feed.every((group) => /^job:[0-9a-f]{12}$/.test(group.job))).toBe(true);
  });

  it("expires a background practice approval in 30 to 60 minutes", async () => {
    const previous = process.env.WOS_BACKGROUND_APPROVAL_MINUTES;
    process.env.WOS_BACKGROUND_APPROVAL_MINUTES = "10";
    try {
      const { orgId } = await createOrg({ actorUserId: "owner", name: "Expiry Co" });
      const lead = await ingestLead({ actorUserId: "owner", orgId, source: "web_form", externalKey: "practice", email: "lead@example.test", customBody: "Thanks. This reply is not sent." });
      expect(lead.outcome).toBe("queued");
      const [row] = await withTenant(orgId, (tx) => tx.select().from(approvalRequests));
      const windowMs = row!.expiresAt.getTime() - Date.now();
      expect(windowMs).toBeGreaterThanOrEqual(29 * 60 * 1000);
      expect(windowMs).toBeLessThanOrEqual(31 * 60 * 1000);
      process.env.WOS_BACKGROUND_APPROVAL_MINUTES = "90";
      const later = await ingestLead({ actorUserId: "owner", orgId, source: "web_form", externalKey: "practice-long", email: "lead@example.test", customBody: "A second draft that is not sent." });
      const rows = await withTenant(orgId, (tx) => tx.select().from(approvalRequests));
      const second = rows.find((r) => r.id === later.approvalId);
      const longWindow = second!.expiresAt.getTime() - Date.now();
      expect(longWindow).toBeGreaterThanOrEqual(59 * 60 * 1000);
      expect(longWindow).toBeLessThanOrEqual(61 * 60 * 1000);
    } finally {
      if (previous === undefined) delete process.env.WOS_BACKGROUND_APPROVAL_MINUTES;
      else process.env.WOS_BACKGROUND_APPROVAL_MINUTES = previous;
    }
  });

  it("stores the first-run fact and undo keeps it from coming back", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Practice Co" });
    const first = await firstRunFor({ actorUserId: "owner", orgId, businessName: "Practice Co", packId: "general" });
    expect(first.practiceMemoryId).toBeTruthy();
    await undoPracticeMemory({ actorUserId: "owner", orgId, memoryId: first.practiceMemoryId! });
    const again = await firstRunFor({ actorUserId: "owner", orgId, businessName: "Practice Co", packId: "general" });
    expect(again.practiceMemoryId).toBeNull();
  });

  it("redacts emails and provider keys on library titles", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Library Co" });
    const raw = "client@example.test sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const saved = await saveArtifact({ actorUserId: "owner", orgId, title: raw });
    expect(saved.title).not.toMatch(/example\.test|sk-ant/);
    const listed = await listArtifacts({ actorUserId: "owner", orgId });
    const opened = await readArtifactByToken({ actorUserId: "owner", orgId, token: saved.token });
    expect(JSON.stringify({ listed, opened })).not.toMatch(/example\.test|sk-ant/);
    expect(opened.title).toMatch(/\[email\]|\[REDACTED\]/);
  });

  it("limits the money digest to the last 7 days and stores the cap in cents", async () => {
    const now = new Date("2026-11-07T15:00:00Z");
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Money Co" });
    await withTenant(orgId, (tx) => tx.insert(invoices).values([
      { tenantId: orgId, provider: "fake", externalId: "old", status: "open", amountDueCents: 9999, createdAt: new Date("2026-10-01T00:00:00Z") },
      { tenantId: orgId, provider: "fake", externalId: "open", status: "open", amountDueCents: 2500, createdAt: new Date("2026-11-06T00:00:00Z") },
      { tenantId: orgId, provider: "fake", externalId: "paid", status: "paid", amountDueCents: 4000, createdAt: new Date("2026-11-05T00:00:00Z") },
    ]));
    const snap = await moneySnapshot({ actorUserId: "owner", orgId, now });
    expect(snap.openCents).toBe(2500);
    expect(snap.collectedCents).toBe(4000);
    expect(snap.invoicedCents).toBe(6500);
    expect(snap.autoPay).toBe(false);
    expect((await saveMoneyCap({ actorUserId: "owner", orgId, weeklyCapDollars: 500 })).weeklyCapCents).toBe(50_000);
  });

  it("enforces quiet hours and the daily cap when deciding what to show", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Notify Co" });
    await saveNotifyPrefs({ actorUserId: "owner", orgId, quietStart: 21, quietEnd: 8, cap: 1 });
    const items = [{ id: "a", tier: 2 }, { id: "b", tier: 2 }];
    const quiet = await deliverNotifications({ actorUserId: "owner", orgId, items, now: new Date("2026-11-07T03:00:00Z") });
    expect(quiet.quiet).toBe(true);
    expect(quiet.now).toEqual([]);
    expect(quiet.brief.map((item) => item.id)).toEqual(["a", "b"]);
    const day = new Date("2026-11-07T16:00:00Z");
    const first = await deliverNotifications({ actorUserId: "owner", orgId, items, now: day });
    expect(first.quiet).toBe(false);
    expect(first.now.map((item) => item.id)).toEqual(["a"]);
    expect(first.brief.map((item) => item.id)).toEqual(["b"]);
    const again = await deliverNotifications({ actorUserId: "owner", orgId, items: [...items, { id: "c", tier: 2 }], now: day });
    expect(again.now.map((item) => item.id)).toEqual(["a"]);
    expect(again.brief.map((item) => item.id).sort()).toEqual(["b", "c"]);
  });

  it("does not start a follow-up chip without a real conversation", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Chip Co" });
    const { taskId } = await createTask({ actorUserId: "owner", orgId, intent: "Reply to the customer" });
    expect(await chipsForTask({ actorUserId: "owner", orgId, taskId })).toEqual([]);
    await expect(startChipAction({ actorUserId: "owner", orgId, taskId, kind: "follow_up" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("binds a takeover draft into the run that resumes", async () => {
    const model = new MockModelProvider((req) => (req.purpose === "classify" ? { text: "inbox" } : {}));
    configureEngine({ router: new ModelRouter([model], "mock"), tools: new ToolRegistry().register(...memoryTools(), ...mockTools(new MockLedger())) });
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Draft Co" });
    await createAgent({ actorUserId: "owner", orgId, spec: { kind: "inbox", displayName: "Inbox", instructions: "Draft only.", tools: [{ name: "memory.note", maxTier: 1 }] } });
    const { taskId } = await createTask({ actorUserId: "owner", orgId, intent: "Reply to the customer" });
    await pauseTask({ actorUserId: "owner", orgId, taskId });
    await takeOverDraft({ actorUserId: "owner", orgId, taskId, text: "Use this exact draft and do not send it." });
    const back = await handBack({ actorUserId: "owner", orgId, taskId });
    expect(back).toMatchObject({ sent: false, bound: true });
    const [row] = await withTenant(orgId, (tx) => tx.select().from(tasks).where(eq(tasks.id, taskId)));
    expect(row?.input).toMatchObject({ ownerDraft: "Use this exact draft and do not send it." });
    await runTask(orgId, taskId);
    const prompt = model.calls.find((call) => call.purpose === "plan")?.messages[0]?.content ?? "";
    expect(prompt).toContain("Use this exact draft and do not send it.");
  });

  it("drafts opportunities and batches notifications", () => {
    const cards = opportunityCardsForPack("hvac", new Date("2026-06-15T15:00:00Z"));
    expect(cards.every((c) => c.requiresApproval)).toBe(true);
    expect(cards.some((c) => c.draft.toLowerCase().includes("draft") || c.draft.toLowerCase().includes("ok"))).toBe(true);
    expect(classifyUrgency({ sameDay: true })).toBe("now");
    expect(classifyUrgency({})).toBe("brief");
    expect(withinQuietHours(22)).toBe(true);
    expect(withinQuietHours(10)).toBe(false);
    const batched = batchNotifications(
      [{ id: "a", urgency: "now" as const }, { id: "a", urgency: "now" as const }, { id: "b", urgency: "brief" as const }],
      { hour: 22, alreadyToday: 0 },
    );
    expect(batched.now).toEqual([]);
    expect(batched.brief.map((i) => i.id)).toEqual(["a", "b"]);
    expect(moneyDigest({ invoicedCents: 5000, collectedCents: 2000 }).autoPay).toBe(false);
    expect(parseForget("forget commercial work")).toBe("commercial work");
    const script = firstRunScript({ businessName: "Ada HVAC", packId: "hvac" });
    expect(script.mock).toBe(true);
    expect(script.lead.needsApproval).toBe(true);
    expect(script.textDemo.label).toBe("DEMO");
  });
});

describe("pending effect lock and mock replay", () => {
  beforeEach(async () => {
    await resetDb();
    await seedUser("owner", "owner@example.test");
    configureEngine({ router: new ModelRouter([new MockModelProvider(() => ({}))], "mock"), tools: new ToolRegistry() });
    resetAppliedEffects();
    resetMockRetries();
    registerIntegrationHandlers();
    setIntegrationJournal(auditJournal());
  });
  afterAll(async () => {
    await stopBoss();
    await closePool();
  });

  it("a replay during an in-flight effect does not apply twice", async () => {
    let applies = 0;
    const event = { tenantId: "t", idempotencyKey: "lock", type: "integration.mail", source: "mail" };
    const handler = {
      type: "integration.mail",
      maxTier: 0,
      decide: () => ({ act: true, reason: "go" }),
      act: (_e: typeof event, ctx: { signal: AbortSignal; once: <T>(fn: () => Promise<T>) => Promise<T> }) => ctx.once(async () => {
        await new Promise((r) => setTimeout(r, 40));
        applies++;
        return { ok: true };
      }),
    };
    const journal = (await import("../src/events/bus")).MemoryJournal;
    const mem = new journal();
    const first = runEvent(event, handler, { journal: mem, timeoutMs: 200, maxAttempts: 1, sleep: async () => undefined });
    const second = runEvent(event, handler, { journal: mem, timeoutMs: 200, maxAttempts: 1, sleep: async () => undefined });
    await Promise.all([first, second]);
    expect(applies).toBe(1);
  });

  it("replays a failed mock payment exactly once", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Retry Co" });
    let tries = 0;
    await expect(produceIntegration({
      tenantId: orgId,
      integration: "payments",
      idempotencyKey: "pay-1",
      journal: auditJournal(),
      mock: true,
      retry: async () => {
        tries++;
        return { externalId: "mock-invoice", mock: true };
      },
      effect: async () => { throw new Error("mock down"); },
    })).rejects.toThrow(/mock down/);
    const [letter] = await listDeadLetters({ actorUserId: "owner", orgId });
    expect(letter?.type).toBe("integration.payments");
    const replayed = await replayDeadLetter({ actorUserId: "owner", orgId, auditId: letter!.id });
    expect(replayed.status).toBe("done");
    expect(replayed.result).toMatchObject({ retried: true, mock: true });
    expect(tries).toBe(1);
    const again = await replayDeadLetter({ actorUserId: "owner", orgId, auditId: letter!.id });
    expect(again.status === "done" || again.status === "duplicate").toBe(true);
    expect(tries).toBe(1);
  });

  it("does not run a live provider retry or report it as mock", async () => {
    let calls = 0;
    rememberMockRetry("tenant", "live-key", async () => {
      calls++;
      return { externalId: "should-not-run", mock: true };
    }, false);
    expect(await runMockRetry("tenant", "live-key")).toBeNull();
    expect(calls).toBe(0);

    const { orgId } = await createOrg({ actorUserId: "owner", name: "Live Retry Co" });
    await expect(produceIntegration({
      tenantId: orgId,
      integration: "payments",
      idempotencyKey: "pay-live",
      mock: false,
      journal: auditJournal(),
      retry: async () => {
        calls++;
        return { externalId: "live-invoice", mock: true };
      },
      effect: async () => {
        throw new Error("live down");
      },
    })).rejects.toThrow(/live down/);
    const [letter] = await listDeadLetters({ actorUserId: "owner", orgId });
    const replayed = await replayDeadLetter({ actorUserId: "owner", orgId, auditId: letter!.id });
    expect(calls).toBe(0);
    expect(replayed.status).toBe("done");
    expect(replayed.result).not.toMatchObject({ mock: true });
  });
});

describe("artifact links", () => {
  it("expires", () => {
    const artifact = { id: "1", title: "Note", token: "abc", expiresAt: "2020-01-01T00:00:00Z" };
    expect(artifactLinkOpen(artifact, new Date("2026-01-01T00:00:00Z"))).toBe(false);
  });
});
