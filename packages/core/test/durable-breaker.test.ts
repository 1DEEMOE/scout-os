import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closePool, withTenant } from "@wos/db";
import { createOrg } from "../src/index";
import { BreakerOpenError, DurableCircuitBreaker } from "../src/events/breaker";
import { adminQuery, resetDb, seedUser } from "../../db/test/helpers";

// DurableCircuitBreaker (migration 0022) shares state across processes through
// integration_breakers. These tests run as the app role (RLS + grants apply) and
// use two concurrent callers to stand in for two processes.

const THRESHOLD = 3;
const COOL = 30_000;
const T0 = 1_800_000_000_000; // fixed clock; the breaker takes `now` as an argument

let tenantA = "";
let tenantB = "";
const breaker = () => new DurableCircuitBreaker({ threshold: THRESHOLD, coolDownMs: COOL });
const boom = async () => {
  throw new Error("provider down");
};

async function row(tenant: string, name: string) {
  const r = (await withTenant(tenant, async (tx) =>
    (await tx.execute(sql`SELECT state, failures, open_until FROM integration_breakers WHERE name = ${name}`)).rows[0],
  )) as { state: string; failures: number; open_until: string | Date | null } | undefined;
  // Raw SQL hands timestamps back as strings; normalise so tests can compare instants.
  return r && { ...r, open_until: r.open_until === null ? null : new Date(r.open_until) };
}

async function failTimes(b: DurableCircuitBreaker, tenant: string, name: string, n: number, now = T0) {
  for (let i = 0; i < n; i++) await b.run(name, boom, now, tenant).catch(() => undefined);
}

describe("DurableCircuitBreaker", () => {
  beforeEach(async () => {
    await resetDb();
    await seedUser("owner", "owner@example.test");
    tenantA = (await createOrg({ actorUserId: "owner", name: "Breaker A" })).orgId;
    tenantB = (await createOrg({ actorUserId: "owner", name: "Breaker B" })).orgId;
  });
  afterAll(async () => {
    await closePool();
  });

  it("opens after the threshold and refuses calls until the cool-down passes", async () => {
    const b = breaker();
    await failTimes(b, tenantA, "stripe", THRESHOLD);
    expect(await row(tenantA, "stripe")).toMatchObject({ state: "open", failures: THRESHOLD });
    let called = false;
    await expect(b.run("stripe", async () => { called = true; }, T0 + 1_000, tenantA)).rejects.toBeInstanceOf(BreakerOpenError);
    expect(called).toBe(false);
  });

  it("one tenant's failures do not open another tenant's breaker", async () => {
    const b = breaker();
    await failTimes(b, tenantA, "gmail", THRESHOLD);
    expect((await row(tenantA, "gmail"))?.state).toBe("open");
    expect(await row(tenantB, "gmail")).toBeUndefined();
    await expect(b.run("gmail", async () => "ok", T0, tenantB)).resolves.toBe("ok");
  });

  describe("reset() as the app role (app_user has no DELETE on integration_breakers)", () => {
    it("closes one named breaker so the next call runs", async () => {
      const b = breaker();
      await failTimes(b, tenantA, "nws", THRESHOLD);
      await failTimes(b, tenantA, "spc", THRESHOLD);
      await b.reset(tenantA, "nws");
      expect(await row(tenantA, "nws")).toMatchObject({ state: "closed", failures: 0, open_until: null });
      expect((await row(tenantA, "spc"))?.state).toBe("open");
      await expect(b.run("nws", async () => "ok", T0 + 1, tenantA)).resolves.toBe("ok");
    });

    it("closes every breaker for the tenant when no name is given, and leaves other tenants alone", async () => {
      const b = breaker();
      await failTimes(b, tenantA, "nws", THRESHOLD);
      await failTimes(b, tenantA, "spc", THRESHOLD);
      await failTimes(b, tenantB, "nws", THRESHOLD);
      await b.reset(tenantA);
      expect((await row(tenantA, "nws"))?.state).toBe("closed");
      expect((await row(tenantA, "spc"))?.state).toBe("closed");
      expect((await row(tenantB, "nws"))?.state).toBe("open");
    });

    it("resetting a breaker that never existed is a no-op", async () => {
      await expect(breaker().reset(tenantA, "never-seen")).resolves.toBeUndefined();
      expect(await row(tenantA, "never-seen")).toBeUndefined();
    });
  });

  describe("concurrency", () => {
    it("counts every concurrent failure (no lost updates)", async () => {
      const b = breaker();
      const N = 8;
      let executed = 0;
      const slowFail = async () => {
        executed++;
        await new Promise((r) => setTimeout(r, 25)); // keep callers in flight together
        throw new Error("provider down");
      };
      const results = await Promise.allSettled(Array.from({ length: N }, () => b.run("stripe", slowFail, T0, tenantA)));
      expect(results.every((r) => r.status === "rejected")).toBe(true);
      // A caller that starts after the breaker has opened is refused and never runs, so how many
      // ran depends on timing. What must hold: every call that ran is counted, none is lost.
      // (>= THRESHOLD is guaranteed: the breaker cannot open before THRESHOLD failures exist.)
      expect(executed).toBeGreaterThanOrEqual(THRESHOLD);
      expect(executed).toBeLessThanOrEqual(N);
      expect(await row(tenantA, "stripe")).toMatchObject({ state: "open", failures: executed });
    });

    it("a success after failures still closes the breaker and clears the count", async () => {
      const b = breaker();
      await failTimes(b, tenantA, "stripe", 2);
      await b.run("stripe", async () => "ok", T0, tenantA);
      expect(await row(tenantA, "stripe")).toMatchObject({ state: "closed", failures: 0 });
    });

    it("after the cool-down only ONE caller probes; the others are refused", async () => {
      const b = breaker();
      await failTimes(b, tenantA, "stripe", THRESHOLD);
      const later = T0 + COOL + 1;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let executions = 0;
      const probe = async () => {
        executions++;
        await gate; // hold the probe open while the others arrive
        return "ok";
      };
      // Refused callers reject while the probe is still held open, so settle each one
      // as it is created (otherwise the early rejections are reported as unhandled).
      let refusedSoFar = 0;
      const settle = (p: Promise<string | void>) =>
        p.then(
          (value): PromiseSettledResult<string | void> => ({ status: "fulfilled", value }),
          (reason): PromiseSettledResult<string | void> => {
            if (reason instanceof BreakerOpenError) refusedSoFar++;
            return { status: "rejected", reason };
          },
        );
      const callers = Array.from({ length: 6 }, () => settle(b.run("stripe", probe, later, tenantA)));
      // Hold the probe open until the other five have actually been refused. Waiting on that
      // event, not on a timer, keeps the test deterministic however slowly connections arrive.
      const deadline = Date.now() + 10_000;
      while (refusedSoFar < 5 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      release();
      const settled = await Promise.all(callers);
      expect(executions).toBe(1);
      expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
      const refused = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
      expect(refused).toHaveLength(5);
      expect(refused.every((s) => s.reason instanceof BreakerOpenError)).toBe(true);
      expect(await row(tenantA, "stripe")).toMatchObject({ state: "closed", failures: 0 });
    });

    it("a failed probe re-opens the breaker for a fresh cool-down", async () => {
      const b = breaker();
      await failTimes(b, tenantA, "stripe", THRESHOLD);
      const later = T0 + COOL + 1;
      await expect(b.run("stripe", boom, later, tenantA)).rejects.toThrow("provider down");
      const after = await row(tenantA, "stripe");
      expect(after?.state).toBe("open");
      expect(after?.open_until?.getTime()).toBe(later + COOL);
      await expect(b.run("stripe", async () => "ok", later + 1, tenantA)).rejects.toBeInstanceOf(BreakerOpenError);
    });

    it("a probe that crashed mid-flight does not wedge the breaker: its lease expires and another caller probes", async () => {
      const b = breaker();
      await failTimes(b, tenantA, "stripe", THRESHOLD);
      // Simulate a worker that claimed the probe and then died: half_open with a lease that has run out.
      await adminQuery(
        `UPDATE integration_breakers SET state = 'half_open', open_until = $2 WHERE tenant_id = $1 AND name = 'stripe'`,
        [tenantA, new Date(T0 + COOL)],
      );
      // Lease still running: refused.
      await expect(b.run("stripe", async () => "ok", T0 + COOL - 1, tenantA)).rejects.toBeInstanceOf(BreakerOpenError);
      // Lease expired: taken over.
      await expect(b.run("stripe", async () => "ok", T0 + COOL + 1, tenantA)).resolves.toBe("ok");
      expect((await row(tenantA, "stripe"))?.state).toBe("closed");
    });
  });
});
