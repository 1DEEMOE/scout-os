import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@wos/db";
import {
  acceptInvitation,
  AppError,
  ConsoleMailSender,
  createOrg,
  inviteMember,
  listInvitations,
  listMembers,
  removeMember,
  revokeInvitation,
  setMailSenderForTests,
  setMemberRole,
  type MailSender,
  type OutboundMail,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

/** A real-behaving sender for tests: captures instead of delivering, and isn't MOCK. */
class CapturingSender implements MailSender {
  readonly name = "capture";
  readonly mock = false;
  readonly sent: OutboundMail[] = [];
  async send(m: OutboundMail) {
    this.sent.push(m);
    return { id: `c${this.sent.length}` };
  }
}
let mail: CapturingSender;

async function expectCode(p: Promise<unknown>, code: AppError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
}

beforeEach(async () => {
  await resetDb();
  await seedUser("owner", "owner@example.test");
  await seedUser("admin", "admin@example.test");
  await seedUser("member", "member@example.test");
  mail = new CapturingSender();
  setMailSenderForTests(mail);
});

afterAll(async () => {
  await closePool();
});

function tokenFrom(url: string): string {
  return new URL(url).searchParams.get("token")!;
}

describe("invitations", () => {
  it("never reports an invitation as emailed when email isn't configured (MOCK sender)", async () => {
    const mock = new ConsoleMailSender();
    setMailSenderForTests(mock);
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    const r = await inviteMember({ actorUserId: "owner", orgId, email: "new@example.test", role: "member" });
    if (r.kind !== "invitation") throw new Error("expected an invitation");
    expect(r).toMatchObject({ emailed: false, emailDelivery: "not_configured" });
    expect(r.acceptUrl).toContain("/accept-invite?"); // the inviter still gets a link to share
  });

  it("reports a failed send as failed", async () => {
    setMailSenderForTests({ name: "broken", mock: false, send: async () => { throw new Error("SMTP 421"); } });
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    const r = await inviteMember({ actorUserId: "owner", orgId, email: "new@example.test", role: "member" });
    expect(r).toMatchObject({ emailed: false, emailDelivery: "failed" });
  });

  it("invites someone without an account: stores only the token hash and emails the link", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    const r = await inviteMember({ actorUserId: "owner", orgId, email: "New@Example.test", role: "member" });
    expect(r.kind).toBe("invitation");
    if (r.kind !== "invitation") return;
    expect(r).toMatchObject({ emailed: true, emailDelivery: "sent" });
    expect(r.acceptUrl).toContain(`/accept-invite?org=${orgId}&token=`);

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe("new@example.test");
    expect(mail.sent[0]!.text).toContain(r.acceptUrl);

    const inv = (await listInvitations({ actorUserId: "owner", orgId }))[0]!;
    expect(inv.status).toBe("pending");
    expect(inv.email).toBe("new@example.test");

    // The stored hash must not be the token itself.
    const rows = await withTenant(orgId, (tx) => tx.execute(sql`SELECT token_hash FROM organization_invitations`));
    const hash = (rows.rows[0] as { token_hash: string }).token_hash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(tokenFrom(r.acceptUrl));
  });

  it("refuses a duplicate pending invitation for the same email", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    await inviteMember({ actorUserId: "owner", orgId, email: "x@example.test", role: "member" });
    await expectCode(inviteMember({ actorUserId: "owner", orgId, email: "X@example.test", role: "viewer" }), "CONFLICT");
  });

  it("accept: right email joins with the invited role; replay fails", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    const r = await inviteMember({ actorUserId: "owner", orgId, email: "newbie@example.test", role: "viewer" });
    if (r.kind !== "invitation") throw new Error("expected invitation");
    const token = tokenFrom(r.acceptUrl);
    await seedUser("newbie", "newbie@example.test"); // they sign up from the email link

    const accepted = await acceptInvitation({ actorUserId: "newbie", orgId, token });
    expect(accepted).toEqual({ orgId, role: "viewer" });
    expect((await listMembers({ actorUserId: "owner", orgId })).map((m) => m.userId)).toContain("newbie");

    await expectCode(acceptInvitation({ actorUserId: "newbie", orgId, token }), "NOT_FOUND");
    const inv = (await listInvitations({ actorUserId: "owner", orgId }))[0]!;
    expect(inv.status).toBe("accepted");
  });

  it("accept with a different signed-in email is refused without revealing the invited address", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    const r = await inviteMember({ actorUserId: "owner", orgId, email: "newbie@example.test", role: "member" });
    if (r.kind !== "invitation") throw new Error("expected invitation");
    await seedUser("newbie", "newbie@example.test");
    await expectCode(acceptInvitation({ actorUserId: "member", orgId, token: tokenFrom(r.acceptUrl) }), "FORBIDDEN");
    // And the invitation is still usable by the right person.
    await acceptInvitation({ actorUserId: "newbie", orgId, token: tokenFrom(r.acceptUrl) });
  });

  it("revoked and expired invitations cannot be accepted", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    const r1 = await inviteMember({ actorUserId: "owner", orgId, email: "newbie@example.test", role: "member" });
    if (r1.kind !== "invitation") throw new Error("expected invitation");
    await revokeInvitation({ actorUserId: "owner", orgId, invitationId: r1.invitationId });
    await expectCode(acceptInvitation({ actorUserId: "newbie", orgId, token: tokenFrom(r1.acceptUrl) }), "NOT_FOUND");

    const r2 = await inviteMember({ actorUserId: "owner", orgId, email: "newbie@example.test", role: "member" });
    if (r2.kind !== "invitation") throw new Error("expected invitation");
    await withTenant(orgId, (tx) => tx.execute(sql`UPDATE organization_invitations SET created_at = created_at - interval '8 days', expires_at = now() - interval '1 hour'`));
    await expectCode(acceptInvitation({ actorUserId: "newbie", orgId, token: tokenFrom(r2.acceptUrl) }), "NOT_FOUND");
    expect((await listInvitations({ actorUserId: "owner", orgId })).map((i) => i.status).sort()).toEqual(["expired", "revoked"]);
  });

  it("non-managers cannot list or revoke invitations", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
    const r = await inviteMember({ actorUserId: "owner", orgId, email: "newbie@example.test", role: "member" });
    if (r.kind !== "invitation") throw new Error("expected invitation");
    await expectCode(listInvitations({ actorUserId: "member", orgId }), "FORBIDDEN");
    await expectCode(revokeInvitation({ actorUserId: "member", orgId, invitationId: r.invitationId }), "FORBIDDEN");
    await expectCode(listInvitations({ actorUserId: "newbie", orgId }), "NOT_FOUND");
  });
});

describe("removeMember", () => {
  async function orgWithMembers() {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    await inviteMember({ actorUserId: "owner", orgId, email: "admin@example.test", role: "admin" });
    await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
    return orgId;
  }

  it("a manager removes a member; the member loses access", async () => {
    const orgId = await orgWithMembers();
    await removeMember({ actorUserId: "admin", orgId, userId: "member" });
    expect((await listMembers({ actorUserId: "owner", orgId })).map((m) => m.userId)).toEqual(["owner", "admin"]);
    await expectCode(listMembers({ actorUserId: "member", orgId }), "NOT_FOUND");
  });

  it("an admin cannot remove an owner or admin", async () => {
    const orgId = await orgWithMembers();
    await expectCode(removeMember({ actorUserId: "admin", orgId, userId: "owner" }), "FORBIDDEN");
  });

  it("the last owner can never be removed", async () => {
    const orgId = await orgWithMembers();
    await expectCode(removeMember({ actorUserId: "owner", orgId, userId: "owner" }), "CONFLICT");
  });

  it("a second owner can remove the first", async () => {
    const orgId = await orgWithMembers();
    await seedUser("second", "second@example.test");
    await inviteMember({ actorUserId: "owner", orgId, email: "second@example.test", role: "owner" });
    await removeMember({ actorUserId: "second", orgId, userId: "owner" });
    expect((await listMembers({ actorUserId: "second", orgId })).map((m) => m.userId)).not.toContain("owner");
  });

  it("refuses non-members and missing targets", async () => {
    const orgId = await orgWithMembers();
    await seedUser("outsider", "outsider@example.test");
    await expectCode(removeMember({ actorUserId: "outsider", orgId, userId: "member" }), "NOT_FOUND");
    await expectCode(removeMember({ actorUserId: "owner", orgId, userId: "outsider" }), "NOT_FOUND");
  });
});

describe("setMemberRole", () => {
  async function orgWithMembers() {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Acme" });
    await inviteMember({ actorUserId: "owner", orgId, email: "admin@example.test", role: "admin" });
    await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
    return orgId;
  }

  it("an admin can toggle member and viewer, but not grant admin or owner", async () => {
    const orgId = await orgWithMembers();
    await setMemberRole({ actorUserId: "admin", orgId, userId: "member", role: "viewer" });
    expect((await listMembers({ actorUserId: "owner", orgId })).find((m) => m.userId === "member")!.role).toBe("viewer");
    await expectCode(setMemberRole({ actorUserId: "admin", orgId, userId: "member", role: "admin" }), "FORBIDDEN");
    await expectCode(setMemberRole({ actorUserId: "admin", orgId, userId: "member", role: "owner" }), "FORBIDDEN");
  });

  it("an owner can promote to admin and owner", async () => {
    const orgId = await orgWithMembers();
    await setMemberRole({ actorUserId: "owner", orgId, userId: "member", role: "admin" });
    await setMemberRole({ actorUserId: "owner", orgId, userId: "admin", role: "owner" });
    const roles = new Map((await listMembers({ actorUserId: "owner", orgId })).map((m) => [m.userId, m.role]));
    expect(roles.get("member")).toBe("admin");
    expect(roles.get("admin")).toBe("owner");
  });

  it("the last owner cannot be demoted", async () => {
    const orgId = await orgWithMembers();
    await expectCode(setMemberRole({ actorUserId: "owner", orgId, userId: "owner", role: "member" }), "CONFLICT");
  });
});
