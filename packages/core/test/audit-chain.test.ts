import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvents, closePool, withTenant } from "@wos/db";
import { AppError, createOrg, entryHashOf, inviteMember, verifyAuditChain } from "../src/index";
import { ownerQuery, resetDb, seedUser } from "../../db/test/helpers";

async function chainRows(orgId: string) {
  return withTenant(orgId, (tx) => tx.select().from(auditEvents).orderBy(auditEvents.seq));
}

beforeEach(async () => {
  await resetDb();
  await seedUser("owner", "owner@example.test");
  await seedUser("member", "member@example.test");
});

afterAll(async () => {
  await closePool();
});

describe("audit hash chain (G4)", () => {
  it("links each entry to its predecessor and verifies cleanly", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });

    const rows = await chainRows(orgId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]!.prevHash).toBeNull();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.prevHash).toBe(rows[i - 1]!.entryHash);
    }
    // Every stored hash recomputes from the row's content.
    for (const r of rows) {
      expect(
        entryHashOf(r.prevHash, {
          tenantId: r.tenantId,
          actorType: r.actorType,
          actorId: r.actorId,
          action: r.action,
          target: r.target,
          tier: r.tier,
          outcome: r.outcome,
          idempotencyKey: r.idempotencyKey,
          approvalRequestId: r.approvalRequestId,
          metadata: r.metadata as Record<string, unknown>,
          at: r.at,
        }),
      ).toBe(r.entryHash);
    }

    const v = await verifyAuditChain({ actorUserId: "owner", orgId });
    expect(v).toEqual({ ok: true, checked: rows.length, legacy: 0 });
  });

  it("detects tampering with a row's content", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });

    // Forge history as the table owner (FORCE RLS blocks the update, so drop it for the tamper).
    await ownerQuery("ALTER TABLE audit_events DISABLE ROW LEVEL SECURITY");
    try {
      await ownerQuery("UPDATE audit_events SET metadata = '{\"forged\":true}'::jsonb WHERE seq = (SELECT min(seq) FROM audit_events)");
    } finally {
      await ownerQuery("ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY");
    }

    const v = await verifyAuditChain({ actorUserId: "owner", orgId });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("stored hash does not match the row's content");
  });

  it("detects a deleted row (broken link)", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
    await inviteMember({ actorUserId: "owner", orgId, email: "new@example.test", role: "viewer" });

    await ownerQuery("ALTER TABLE audit_events DISABLE ROW LEVEL SECURITY");
    try {
      await ownerQuery("DELETE FROM audit_events WHERE seq = (SELECT min(seq) FROM audit_events) + 1");
    } finally {
      await ownerQuery("ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY");
    }

    const v = await verifyAuditChain({ actorUserId: "owner", orgId });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("broken link to the previous entry");
  });

  it("tolerates pre-chain legacy rows written before the feature", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    // Simulate a row from before migration 0010: no hashes at all.
    await withTenant(orgId, (tx) =>
      tx.execute(sql`INSERT INTO audit_events (tenant_id, actor_type, actor_id, action, outcome) VALUES (${orgId}, 'user', 'owner', 'legacy.import', 'success')`),
    );
    // Hmm: the row above lands AFTER chained rows, so it must be flagged...
    const v = await verifyAuditChain({ actorUserId: "owner", orgId });
    expect(v.ok).toBe(false);

    // ...but when the legacy row is older than the chain, it's fine.
    const { orgId: org2 } = await createOrg({ actorUserId: "owner", name: "Beta" });
    await ownerQuery("ALTER TABLE audit_events DISABLE ROW LEVEL SECURITY");
    try {
      await ownerQuery("DELETE FROM audit_events WHERE tenant_id = $1", [org2]);
    } finally {
      await ownerQuery("ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY");
    }
    await withTenant(org2, async (tx) => {
      await tx.execute(sql`INSERT INTO audit_events (tenant_id, actor_type, actor_id, action, outcome) VALUES (${org2}, 'user', 'owner', 'legacy.import', 'success')`);
    });
    await inviteMember({ actorUserId: "owner", orgId: org2, email: "member@example.test", role: "member" });
    const v2 = await verifyAuditChain({ actorUserId: "owner", orgId: org2 });
    expect(v2.ok).toBe(true);
    expect(v2.legacy).toBe(1);
    expect(v2.checked).toBeGreaterThanOrEqual(1);
  });

  it("serializes concurrent writers so the chain stays intact", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => inviteMember({ actorUserId: "owner", orgId, email: `u${i}@example.test`, role: "member" }).catch(() => undefined)),
    );
    // (These invites create pending invitations, which is fine — we only care about the chain.)
    const v = await verifyAuditChain({ actorUserId: "owner", orgId });
    expect(v.ok).toBe(true);
  });

  it("is manager-only", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
    await expect(verifyAuditChain({ actorUserId: "member", orgId })).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === "FORBIDDEN");
  });
});
