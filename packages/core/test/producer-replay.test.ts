import { Writable } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import {
  auditJournal,
  configureEngine,
  createOrg,
  fetchNwsAlerts,
  listDeadLetters,
  makeLogger,
  MemoryJournal,
  MockModelProvider,
  ModelRouter,
  produceIntegration,
  registerIntegrationHandlers,
  replayDeadLetter,
  resetAppliedEffects,
  resetNwsCache,
  runEvent,
  secretFindings,
  setIntegrationJournal,
  setNwsFetchForTests,
  stopBoss,
  ToolRegistry,
} from "../src/index";
import { integrations } from "../src/events/breaker";
import { resetDb, seedUser } from "../../db/test/helpers";

const badJson = (async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError("bad"); } })) as unknown as typeof fetch;

describe("producer replay", () => {
  beforeEach(async () => {
    await resetDb();
    await seedUser("owner", "owner@example.test");
    configureEngine({ router: new ModelRouter([new MockModelProvider(() => ({}))], "mock"), tools: new ToolRegistry() });
    resetNwsCache();
    resetAppliedEffects();
    registerIntegrationHandlers();
    setIntegrationJournal(auditJournal());
  });
  afterEach(() => {
    setIntegrationJournal(undefined);
    setNwsFetchForTests(undefined);
  });
  afterAll(async () => {
    await stopBoss();
    await closePool();
  });

  it("dead-letters a real weather fetch and the owner replay resolves it", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Replay Weather" });
    let calls = 0;
    setNwsFetchForTests((async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ features: [] }) };
    }) as unknown as typeof fetch);
    await expect(fetchNwsAlerts({ tenantId: orgId })).rejects.toThrow();
    const open = await listDeadLetters({ actorUserId: "owner", orgId });
    expect(open.map((row) => row.type)).toContain("integration.nws");
    const letter = open.find((row) => row.type === "integration.nws")!;
    const result = await replayDeadLetter({ actorUserId: "owner", orgId, auditId: letter.id });
    expect(result.status).toBe("done");
    expect(await listDeadLetters({ actorUserId: "owner", orgId })).toEqual([]);
    expect(calls).toBe(2);
  });
});

describe("effect idempotency and concurrent producers", () => {
  it("replays a timed-out key without applying the effect again", async () => {
    resetAppliedEffects();
    const journal = new MemoryJournal();
    let applies = 0;
    const event = { tenantId: "t", idempotencyKey: "late-replay", type: "integration.nws", source: "nws" };
    const handler = {
      type: "integration.nws",
      maxTier: 0,
      decide: () => ({ act: true, reason: "go" }),
      act: (_e: typeof event, ctx: { signal: AbortSignal; once: <T>(fn: () => Promise<T>) => Promise<T> }) => ctx.once(async () => {
        await new Promise((r) => setTimeout(r, 30));
        applies++;
        return { ok: true };
      }),
    };
    const first = await runEvent(event, handler, { journal, maxAttempts: 3, timeoutMs: 5, sleep: async () => undefined });
    await new Promise((r) => setTimeout(r, 50));
    const second = await runEvent(event, handler, { journal, maxAttempts: 1, timeoutMs: 1000, sleep: async () => undefined });
    expect(first.reason).toBe("timeout");
    expect(second.status === "done" || second.status === "duplicate").toBe(true);
    expect(applies).toBe(1);
  });

  it("returns the first result to a concurrent caller with the same key", async () => {
    const journal = new MemoryJournal();
    let applies = 0;
    const call = () => produceIntegration({
      tenantId: "t",
      integration: "model",
      idempotencyKey: "concurrent",
      journal,
      effect: (ctx) => ctx.once(async () => {
        applies++;
        await new Promise((r) => setTimeout(r, 20));
        return 7;
      }),
    });
    const [a, b] = await Promise.all([call(), call()]);
    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(applies).toBe(1);
  });
});

describe("breaker and redaction gaps", () => {
  it("counts malformed JSON as a weather breaker failure", async () => {
    resetNwsCache();
    for (let i = 0; i < 4; i++) await fetchNwsAlerts({ fetchImpl: badJson, now: new Date() }).catch(() => undefined);
    expect(integrations.snapshot().find((s) => s.name === "nws")?.state).toBe("open");
  });

  it("redacts a provider key and a deeply nested token", () => {
    const lines: string[] = [];
    const log = makeLogger(new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    }));
    log.error({ failure: "model rejected sk-ant-api03-abcDEF1234567890xyz" }, "model failed");
    log.error({ deep: { a: { b: { token: "plain-credential-value" } } } }, "nested");
    log.error({ failure: "Bearer abcdefghijklmnop and AIzaSyAbcdefghij123456 and ghp_abcdef12345678 and xai-abcdef123456" }, "shapes");
    const text = lines.join("\n");
    expect(secretFindings(text)).toEqual([]);
    expect(text).not.toMatch(/sk-ant-|plain-credential-value|AIzaSy|ghp_|xai-|Bearer abc/);
  });
});
