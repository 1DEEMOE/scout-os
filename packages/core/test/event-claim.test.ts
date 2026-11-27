import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePool } from "@wos/db";
import { createOrg, IntegrationBusyError, produceIntegration, resetAppliedEffects, setIntegrationJournal } from "../src/index";
import { durableJournal } from "../src/events/journal";
import type { BusEvent, BusHandler, EventResult } from "../src/events/bus";
import { adminQuery, resetDb, seedUser } from "../../db/test/helpers";

// Migration 0028: events are claimed with a lease BEFORE the effect runs, so two processes
// cannot run the same provider call at once. The bus keeps in-process maps that would hide
// that bug inside a single module instance, so "two workers" here are two independently
// loaded copies of the bus, journal and database pool (as two OS processes would have).

interface World {
  runEvent: typeof import("../src/events/bus").runEvent;
  journal: ReturnType<typeof durableJournal>;
  close: () => Promise<void>;
}
const worlds: World[] = [];
async function newWorker(): Promise<World> {
  vi.resetModules();
  const bus = await import("../src/events/bus");
  const j = await import("../src/events/journal");
  const db = await import("@wos/db");
  const w: World = { runEvent: bus.runEvent, journal: j.durableJournal(), close: db.closePool };
  worlds.push(w);
  return w;
}

let tenant = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const eventFor = (key: string): BusEvent => ({ tenantId: tenant, idempotencyKey: key, type: "integration.test", source: "test", integration: undefined });

function handler(effect: () => Promise<unknown>): BusHandler {
  return { type: "integration.test", maxTier: 0, decide: () => ({ act: true, reason: "test" }), act: async () => ({ ok: true, v: await effect() }) };
}
async function rowOf(key: string) {
  const [r] = await adminQuery<{ status: string; lease_owner: string | null; attempts: number; lease_expires_at: Date | null }>(
    "SELECT status, lease_owner, attempts, lease_expires_at FROM integration_events WHERE tenant_id = $1 AND idempotency_key = $2",
    [tenant, key],
  );
  return r;
}

describe("event claim (migration 0028)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedUser("owner", "owner@example.test");
    tenant = (await createOrg({ actorUserId: "owner", name: "Claim Co" })).orgId;
    resetAppliedEffects();
  });
  afterAll(async () => {
    await Promise.all(worlds.map((w) => w.close().catch(() => undefined)));
    await closePool();
  });

  it("two workers on the same event: the effect runs exactly once, the second is told it is busy", async () => {
    const [w1, w2] = [await newWorker(), await newWorker()];
    const key = `k-${randomUUID()}`;
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const effectStarted = new Promise<void>((r) => (started = r));
    const slow = handler(async () => {
      runs++;
      started();
      await gate;
    });
    const first = w1.runEvent(eventFor(key), slow, { journal: w1.journal });
    await effectStarted; // worker 1 is inside the effect and holds the lease
    const second = await w2.runEvent(eventFor(key), slow, { journal: w2.journal });
    expect(second).toMatchObject({ status: "busy" });
    expect(runs).toBe(1);
    expect((await rowOf(key))?.status).toBe("in_progress");
    release();
    expect((await first).status).toBe("done");
    // Finished now: a later delivery is a plain duplicate and still does not run the effect.
    expect((await w2.runEvent(eventFor(key), slow, { journal: w2.journal })).status).toBe("duplicate");
    expect(runs).toBe(1);
    expect(await rowOf(key)).toMatchObject({ status: "done", lease_owner: null, lease_expires_at: null });
  });

  it("many events delivered to both workers at the same moment: every effect runs once", async () => {
    const [w1, w2] = [await newWorker(), await newWorker()];
    const keys = Array.from({ length: 12 }, () => `k-${randomUUID()}`);
    const runs = new Map<string, number>();
    const settled: EventResult[] = [];
    await Promise.all(
      keys.flatMap((key) =>
        [w1, w2].map(async (w) => {
          const h = handler(async () => {
            runs.set(key, (runs.get(key) ?? 0) + 1);
            await sleep(30);
          });
          settled.push(await w.runEvent(eventFor(key), h, { journal: w.journal }));
        }),
      ),
    );
    for (const key of keys) expect(runs.get(key), key).toBe(1);
    expect(settled.filter((r) => r.status === "done")).toHaveLength(keys.length);
    expect(settled.filter((r) => r.status === "busy" || r.status === "duplicate")).toHaveLength(keys.length);
  });

  it("a worker that dies mid-effect: its key is refused while the lease runs, then another worker recovers it", async () => {
    const [dead, other] = [await newWorker(), await newWorker()];
    const key = `k-${randomUUID()}`;
    // The crashed worker got as far as claiming (a 400 ms lease) and never finished.
    expect(await dead.journal.claim!({ tenantId: tenant, key, type: "integration.test", source: "test", owner: "crashed", leaseMs: 400 })).toBe("claimed");
    let runs = 0;
    const h = handler(async () => void runs++);
    expect((await other.runEvent(eventFor(key), h, { journal: other.journal })).status).toBe("busy");
    expect(runs).toBe(0);
    await sleep(600);
    const recovered = await other.runEvent(eventFor(key), h, { journal: other.journal });
    expect(recovered.status).toBe("done");
    expect(runs).toBe(1);
    expect(await rowOf(key)).toMatchObject({ status: "done", attempts: 2 });
  });

  it("a failed attempt gives the key back, so a replay can run it", async () => {
    const w = await newWorker();
    const key = `k-${randomUUID()}`;
    let runs = 0;
    const flaky = handler(async () => {
      runs++;
      if (runs === 1) throw new Error("provider 500");
    });
    const failed = await w.runEvent(eventFor(key), flaky, { journal: w.journal, maxAttempts: 1, sleep: async () => undefined });
    expect(failed.status).toBe("dead");
    expect(await rowOf(key)).toMatchObject({ status: "failed", lease_owner: null });
    const replay = await w.runEvent(eventFor(key), flaky, { journal: w.journal });
    expect(replay.status).toBe("done");
    expect(runs).toBe(2);
    expect((await rowOf(key))?.status).toBe("done");
  });

  it("a timeout keeps the lease: the effect may still be running, so a replay cannot overlap it", async () => {
    const w = await newWorker();
    const key = `k-${randomUUID()}`;
    let runs = 0;
    let finishHanging!: () => void;
    const hang = new Promise<void>((r) => (finishHanging = r));
    const hangs = handler(async () => {
      runs++;
      await hang;
    });
    const timedOut = await w.runEvent(eventFor(key), hangs, { journal: w.journal, maxAttempts: 1, timeoutMs: 50 });
    expect(timedOut).toMatchObject({ status: "dead", reason: "timeout" });
    expect((await rowOf(key))?.status).toBe("in_progress");
    const replay = await w.runEvent(eventFor(key), handler(async () => void runs++), { journal: w.journal });
    expect(replay.status).toBe("busy");
    expect(runs).toBe(1);
    // Only once the lease is over (forced here) may the key be run again.
    await adminQuery("UPDATE integration_events SET lease_expires_at = now() - interval '1 second' WHERE tenant_id = $1 AND idempotency_key = $2", [tenant, key]);
    expect((await w.runEvent(eventFor(key), handler(async () => void runs++), { journal: w.journal })).status).toBe("done");
    finishHanging();
  });

  it("a worker whose lease was taken over cannot overwrite its successor's result", async () => {
    const [a, b] = [await newWorker(), await newWorker()];
    const key = `k-${randomUUID()}`;
    const base = { tenantId: tenant, key, type: "integration.test", source: "test" };
    expect(await a.journal.claim!({ ...base, owner: "A", leaseMs: 150 })).toBe("claimed");
    expect(await b.journal.claim!({ ...base, owner: "B", leaseMs: 60_000 })).toBe("busy"); // A's lease is live
    await sleep(300);
    expect(await b.journal.claim!({ ...base, owner: "B", leaseMs: 60_000 })).toBe("claimed"); // expired: B takes over
    expect(await a.journal.finish!({ tenantId: tenant, key, owner: "A", outcome: "done", attempt: 1 })).toBe(false);
    expect((await rowOf(key))?.status).toBe("in_progress"); // A did not close B's claim
    expect(await b.journal.finish!({ tenantId: tenant, key, owner: "B", outcome: "done", attempt: 2 })).toBe(true);
    expect(await rowOf(key)).toMatchObject({ status: "done", lease_owner: null });
  });

  it("has() ignores in-progress and failed rows and counts finished ones", async () => {
    const w = await newWorker();
    const key = `k-${randomUUID()}`;
    const base = { tenantId: tenant, key, type: "integration.test", source: "test" };
    await w.journal.claim!({ ...base, owner: "A", leaseMs: 60_000 });
    expect(await w.journal.has(tenant, key)).toBe(false);
    await w.journal.finish!({ ...base, owner: "A", outcome: "failed", attempt: 1 });
    expect(await w.journal.has(tenant, key)).toBe(false);
    await w.journal.claim!({ ...base, owner: "A2", leaseMs: 60_000 });
    await w.journal.finish!({ ...base, owner: "A2", outcome: "done", attempt: 2 });
    expect(await w.journal.has(tenant, key)).toBe(true);
  });

  describe("produceIntegration", () => {
    it("refuses with IntegrationBusyError, without calling the provider, while another process holds the key", async () => {
      const other = await newWorker();
      setIntegrationJournal(durableJournal());
      const key = `pay:${randomUUID()}`;
      await other.journal.claim!({ tenantId: tenant, key, type: "integration.payments", source: "payments", owner: "elsewhere", leaseMs: 60_000 });
      let calls = 0;
      await expect(
        produceIntegration({ tenantId: tenant, integration: "payments", idempotencyKey: key, effect: async () => void calls++ }),
      ).rejects.toBeInstanceOf(IntegrationBusyError);
      expect(calls).toBe(0);
      setIntegrationJournal(undefined);
    });

    it("a repeat call with an already-applied key still reads the result back from the provider", async () => {
      setIntegrationJournal(durableJournal());
      const key = `pay:${randomUUID()}`;
      let calls = 0;
      const effect = async () => ({ externalId: "inv_1", n: ++calls });
      const first = await produceIntegration({ tenantId: tenant, integration: "payments", idempotencyKey: key, effect });
      resetAppliedEffects();
      const again = await produceIntegration({ tenantId: tenant, integration: "payments", idempotencyKey: key, effect });
      expect(first.externalId).toBe("inv_1");
      expect(again.externalId).toBe("inv_1");
      expect(calls).toBe(2); // the provider call is repeated on purpose; it dedupes by the same key
      expect((await rowOf(key))?.status).toBe("done");
      setIntegrationJournal(undefined);
    });
  });
});
