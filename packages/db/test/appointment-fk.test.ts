import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, withTenant } from "../src/index";
import { resetDb } from "./helpers";

// Migration 0028 (Fix 1). appointments references its service and resource with a
// composite foreign key (tenant_id, id). Written as `ON DELETE SET NULL` the action
// tried to null tenant_id as well (NOT NULL), so removing a service or resource that
// had a booking failed. The column-list form nulls only the reference.

const T = randomUUID();
const row = async (tx: Parameters<Parameters<typeof withTenant>[1]>[0], q: ReturnType<typeof sql>) =>
  (await tx.execute(q)).rows[0] as Record<string, string | null>;

describe("appointments foreign keys: deleting a referenced row", () => {
  beforeAll(async () => {
    await resetDb();
    await withTenant(T, (tx) => tx.execute(sql`INSERT INTO organizations (id, name) VALUES (${T}, 'FK Co')`));
  });
  afterAll(async () => {
    await closePool();
  });

  async function seed() {
    return withTenant(T, async (tx) => {
      const svc = await row(tx, sql`INSERT INTO service_menu_items (tenant_id, pack_service_id, label) VALUES (${T}, ${"s-" + randomUUID()}, 'Cut') RETURNING id`);
      const res = await row(tx, sql`INSERT INTO bookable_resources (tenant_id, name, kind) VALUES (${T}, ${"r-" + randomUUID()}, 'chair') RETURNING id`);
      const appt = await row(
        tx,
        sql`INSERT INTO appointments (tenant_id, service_id, resource_id, starts_at, ends_at, status)
            VALUES (${T}, ${svc.id}, ${res.id}, now() + interval '1 day', now() + interval '1 day 1 hour', 'booked') RETURNING id`,
      );
      return { svc: svc.id as string, res: res.id as string, appt: appt.id as string };
    });
  }

  it("deleting a service succeeds (as the app role), clears service_id, keeps tenant_id and resource_id", async () => {
    const s = await seed();
    const deleted = await withTenant(T, (tx) => tx.execute(sql`DELETE FROM service_menu_items WHERE id = ${s.svc}`));
    expect(deleted.rowCount).toBe(1);
    const after = await withTenant(T, (tx) => row(tx, sql`SELECT tenant_id, service_id, resource_id, status FROM appointments WHERE id = ${s.appt}`));
    expect(after).toEqual({ tenant_id: T, service_id: null, resource_id: s.res, status: "booked" });
  });

  it("deleting a resource succeeds, clears resource_id, keeps tenant_id and service_id", async () => {
    const s = await seed();
    const deleted = await withTenant(T, (tx) => tx.execute(sql`DELETE FROM bookable_resources WHERE id = ${s.res}`));
    expect(deleted.rowCount).toBe(1);
    const after = await withTenant(T, (tx) => row(tx, sql`SELECT tenant_id, service_id, resource_id, status FROM appointments WHERE id = ${s.appt}`));
    expect(after).toEqual({ tenant_id: T, service_id: s.svc, resource_id: null, status: "booked" });
  });

  it("the appointment itself survives and stays in its tenant after both parents are gone", async () => {
    const s = await seed();
    await withTenant(T, async (tx) => {
      await tx.execute(sql`DELETE FROM service_menu_items WHERE id = ${s.svc}`);
      await tx.execute(sql`DELETE FROM bookable_resources WHERE id = ${s.res}`);
    });
    const n = await withTenant(T, (tx) => row(tx, sql`SELECT count(*)::int AS n FROM appointments WHERE id = ${s.appt} AND tenant_id = ${T}`));
    expect(n.n).toBe(1);
  });
});
