import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@wos/db";
import { AppError, createOrg, exportTenantData, inviteMember, stopBoss, tenantTables } from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

let orgId: string;

beforeEach(async () => {
  await resetDb();
  for (const u of ["owner", "member", "outsider"]) await seedUser(u, `${u}@example.test`);
  orgId = (await createOrg({ actorUserId: "owner", name: "Export Co" })).orgId;
  await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("tenant data export (executed)", () => {
  it("exports every tenant-scoped table for the org, secrets omitted", async () => {
    const bundle = await exportTenantData({ actorUserId: "owner", orgId });
    expect(bundle.tenantId).toBe(orgId);
    // Every classified tenant table appears in the bundle, empty or not.
    for (const t of tenantTables()) expect(bundle.tables).toHaveProperty(t.name);
    // The org actually has members, so at least one table has rows.
    expect(bundle.tables.organization_members!.length).toBeGreaterThan(0);
    expect(bundle.tables.organizations ?? []).toEqual([]); // organizations has no tenant_id column
    // Secret columns never leave the database.
    for (const rows of Object.values(bundle.tables)) {
      for (const row of rows) {
        expect(row).not.toHaveProperty("secret_ref");
        expect(row).not.toHaveProperty("secret_ciphertext");
        expect(row).not.toHaveProperty("ciphertext");
        expect(row).not.toHaveProperty("token_hash");
      }
    }
  });

  it("contains only this tenant's rows", async () => {
    const other = (await createOrg({ actorUserId: "owner", name: "Other Co" })).orgId;
    const bundle = await exportTenantData({ actorUserId: "owner", orgId });
    for (const rows of Object.values(bundle.tables)) {
      for (const row of rows) {
        if ("tenant_id" in row) expect(row.tenant_id).toBe(orgId);
      }
    }
    expect(bundle.tables.organization_members!.every((r) => r.tenant_id === orgId)).toBe(true);
    expect(other).not.toBe(orgId);
  });

  it("is denied for members and outsiders", async () => {
    await expect(exportTenantData({ actorUserId: "member", orgId })).rejects.toSatisfy((e) => e instanceof AppError && e.code === "FORBIDDEN");
    await expect(exportTenantData({ actorUserId: "outsider", orgId })).rejects.toSatisfy((e) => e instanceof AppError && ["FORBIDDEN", "NOT_FOUND"].includes(e.code));
  });

  it("writes an audit event with table and row counts", async () => {
    const bundle = await exportTenantData({ actorUserId: "owner", orgId });
    const events = await withTenant(orgId, async (tx) => {
      const { rows } = await tx.raw.query(`SELECT action, metadata FROM audit_events WHERE action = 'privacy.export' ORDER BY seq DESC LIMIT 1`);
      return rows as { action: string; metadata: { tables: number; rows: number } }[];
    });
    expect(events[0]?.metadata.tables).toBe(Object.keys(bundle.tables).length);
    expect(events[0]?.metadata.rows).toBeGreaterThan(0);
  });

  it("viewer role cannot call it either (managers only)", async () => {
    await seedUser("view", "view@example.test");
    await inviteMember({ actorUserId: "owner", orgId, email: "view@example.test", role: "viewer" });
    await expect(exportTenantData({ actorUserId: "view", orgId })).rejects.toSatisfy((e) => e instanceof AppError && e.code === "FORBIDDEN");
  });
});
