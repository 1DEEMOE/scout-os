import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@wos/db";
import { AppError, createOrg, inviteMember, listMembers, listMyOrgs } from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

async function auditFor(orgId: string) {
  const r = await withTenant(orgId, (tx) =>
    tx.execute(sql`SELECT actor_id, action, outcome, metadata FROM audit_events ORDER BY at`),
  );
  return r.rows as { actor_id: string; action: string; outcome: string; metadata: Record<string, unknown> }[];
}

async function expectAppError(p: Promise<unknown>, code: AppError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
}

beforeEach(async () => {
  await resetDb();
  await seedUser("owner", "owner@example.test", "Olivia Owner");
  await seedUser("admin", "admin@example.test", "Adam Admin");
  await seedUser("member", "member@example.test", "Mia Member");
  await seedUser("outsider", "outsider@example.test", "Otto Outsider");
});

afterAll(async () => {
  await closePool();
});

describe("createOrg", () => {
  it("creates the org with the creator as owner and writes an audit event", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "  Acme Bookkeeping  " });
    expect(await listMyOrgs({ actorUserId: "owner" })).toEqual([{ orgId, name: "Acme Bookkeeping", role: "owner" }]);
    const audit = await auditFor(orgId);
    expect(audit).toEqual([expect.objectContaining({ actor_id: "owner", action: "org.create", outcome: "success" })]);
  });

  it("rejects an empty or too-long name", async () => {
    await expectAppError(createOrg({ actorUserId: "owner", name: "   " }), "VALIDATION");
    await expectAppError(createOrg({ actorUserId: "owner", name: "x".repeat(121) }), "VALIDATION");
  });
});

describe("inviteMember", () => {
  async function orgWithStaff() {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    await inviteMember({ actorUserId: "owner", orgId, email: "admin@example.test", role: "admin" });
    await inviteMember({ actorUserId: "owner", orgId, email: "MEMBER@example.test", role: "member" });
    return orgId;
  }

  it("lets an owner add existing users, matching email case-insensitively", async () => {
    const orgId = await orgWithStaff();
    const members = await listMembers({ actorUserId: "owner", orgId });
    expect(members.map((m) => [m.userId, m.role])).toEqual([
      ["owner", "owner"],
      ["admin", "admin"],
      ["member", "member"],
    ]);
    const invites = (await auditFor(orgId)).filter((e) => e.action === "org.invite");
    expect(invites).toHaveLength(2);
    expect(invites.every((e) => e.outcome === "success")).toBe(true);
  });

  it("forbids a plain member from inviting, and the denial stays in the audit log", async () => {
    const orgId = await orgWithStaff();
    await expectAppError(
      inviteMember({ actorUserId: "member", orgId, email: "outsider@example.test", role: "member" }),
      "FORBIDDEN",
    );
    const denied = (await auditFor(orgId)).filter((e) => e.outcome === "denied");
    expect(denied).toEqual([expect.objectContaining({ actor_id: "member", action: "org.invite" })]);
  });

  it("lets an admin add members but not owners", async () => {
    const orgId = await orgWithStaff();
    await expectAppError(
      inviteMember({ actorUserId: "admin", orgId, email: "outsider@example.test", role: "owner" }),
      "FORBIDDEN",
    );
    await inviteMember({ actorUserId: "admin", orgId, email: "outsider@example.test", role: "viewer" });
    const roles = (await listMembers({ actorUserId: "admin", orgId })).map((m) => m.role);
    expect(roles).toContain("viewer");
  });

  it("creates a pending invitation for an email with no account", async () => {
    const orgId = await orgWithStaff();
    const r = await inviteMember({ actorUserId: "owner", orgId, email: "nobody@example.test", role: "member" });
    expect(r.kind).toBe("invitation");
  });

  it("returns CONFLICT for an existing member", async () => {
    const orgId = await orgWithStaff();
    await expectAppError(inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "admin" }), "CONFLICT");
  });

  it("validates email and role", async () => {
    const orgId = await orgWithStaff();
    await expectAppError(inviteMember({ actorUserId: "owner", orgId, email: "not-an-email", role: "member" }), "VALIDATION");
    await expectAppError(inviteMember({ actorUserId: "owner", orgId, email: "outsider@example.test", role: "superuser" }), "VALIDATION");
  });
});

describe("tenant isolation through the service", () => {
  it("a user of org A cannot list or invite into org B", async () => {
    const { orgId: a } = await createOrg({ actorUserId: "owner", name: "A" });
    const { orgId: b } = await createOrg({ actorUserId: "outsider", name: "B" });
    await expectAppError(listMembers({ actorUserId: "owner", orgId: b }), "NOT_FOUND");
    await expectAppError(inviteMember({ actorUserId: "owner", orgId: b, email: "member@example.test", role: "member" }), "NOT_FOUND");
    expect((await listMyOrgs({ actorUserId: "owner" })).map((o) => o.orgId)).toEqual([a]);
    expect((await listMembers({ actorUserId: "outsider", orgId: b })).map((m) => m.userId)).toEqual(["outsider"]);
  });

  it("an unknown org id looks the same as one you can't see", async () => {
    await expectAppError(listMembers({ actorUserId: "owner", orgId: "00000000-0000-4000-8000-000000000000" }), "NOT_FOUND");
  });
});
