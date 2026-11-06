import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  organizationInvitations,
  organizationMembers,
  organizations,
  ROLES,
  users,
  withGlobal,
  withTenant,
  withUser,
  type Role,
  type Tx,
} from "@wos/db";
import { recordAudit } from "../audit";
import { ANY_ROLE, auditDenied, inOrg, MANAGERS, requireRole, roleOf } from "./access";
import { AppError } from "../errors";
import { logger } from "../logger";
import { getMailSender } from "../mail/sender";
import { assertSeatAvailable } from "../billing/plans";
import { withSpan } from "../tracing";

const nameSchema = z.string().trim().min(1, "Name is required").max(120, "Name is too long");
const inviteSchema = z.object({
  email: z.email("Enter a valid email address").transform((e) => e.toLowerCase()),
  role: z.enum(ROLES),
});

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: Date;
}

export interface MyOrg {
  orgId: string;
  name: string;
  role: Role;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new AppError("VALIDATION", r.error.issues[0]?.message ?? "Invalid input");
  return r.data;
}

export async function createOrg(input: { actorUserId: string; name: string }): Promise<{ orgId: string }> {
  const name = parse(nameSchema, input.name);
  const orgId = randomUUID();
  return withSpan("org.create", { "org.id": orgId }, () =>
    withTenant(orgId, async (tx) => {
      await tx.insert(organizations).values({ id: orgId, name });
      await tx.insert(organizationMembers).values({ tenantId: orgId, userId: input.actorUserId, role: "owner" });
      await recordAudit(tx, {
        tenantId: orgId,
        actorType: "user",
        actorId: input.actorUserId,
        action: "org.create",
        target: `organization:${orgId}`,
        outcome: "success",
      });
      logger.info({ orgId, actor: input.actorUserId }, "organization created");
      return { orgId };
    }),
  );
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_INVITES = 25;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function acceptUrlFor(orgId: string, token: string): string {
  const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  return `${base}/accept-invite?org=${orgId}&token=${encodeURIComponent(token)}`;
}

export type InviteResult =
  | { kind: "member"; userId: string }
  | { kind: "invitation"; invitationId: string; acceptUrl: string; emailed: boolean };

/**
 * Adds a member to the organization. If the email already has an account the
 * user is added directly (same as before); otherwise a pending invitation is
 * created and emailed. Only the SHA-256 of the invite token is stored, so a
 * database leak does not expose usable invite links.
 */
export async function inviteMember(input: { actorUserId: string; orgId: string; email: string; role: string }): Promise<InviteResult> {
  const { email, role } = parse(inviteSchema, { email: input.email, role: input.role });
  return withSpan("org.invite", { "org.id": input.orgId }, () =>
    inOrg(input.orgId, async (tx) => {
      const actorRole = await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "org.invite");
      if (role === "owner" && actorRole !== "owner") {
        await auditDenied(input.orgId, input.actorUserId, "org.invite", { reason: "admin_cannot_grant_owner" });
        throw new AppError("FORBIDDEN", "Only an owner can add another owner");
      }

      // Users is a global table, so the lookup happens outside the tenant transaction.
      const target = await withGlobal((tx2) =>
        tx2.select({ id: users.id }).from(users).where(eq(sql`lower(${users.email})`, email)),
      );
      const targetId = target[0]?.id;

      if (targetId) {
        if (await roleOf(tx, input.orgId, targetId)) throw new AppError("CONFLICT", "That person is already a member");
        await assertSeatAvailable(tx, input.orgId, input.actorUserId);
        await tx.insert(organizationMembers).values({ tenantId: input.orgId, userId: targetId, role });
        await recordAudit(tx, {
          tenantId: input.orgId,
          actorType: "user",
          actorId: input.actorUserId,
          action: "org.invite",
          target: `user:${targetId}`,
          outcome: "success",
          metadata: { role },
        });
        logger.info({ orgId: input.orgId, actor: input.actorUserId, member: targetId, role }, "member added");
        return { kind: "member", userId: targetId };
      }

      // No account yet: create (or refuse a duplicate) pending invitation.
      const pending = await tx
        .select({ id: organizationInvitations.id })
        .from(organizationInvitations)
        .where(
          and(
            eq(organizationInvitations.tenantId, input.orgId),
            eq(sql`lower(${organizationInvitations.email})`, email),
            eq(organizationInvitations.status, "pending"),
          ),
        );
      if (pending.length > 0) throw new AppError("CONFLICT", "An invitation is already pending for that email");

      const [pendingCount] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(organizationInvitations)
        .where(and(eq(organizationInvitations.tenantId, input.orgId), eq(organizationInvitations.status, "pending")));
      if ((pendingCount?.count ?? 0) >= MAX_PENDING_INVITES) {
        throw new AppError("RATE_LIMITED", `Too many pending invitations (max ${MAX_PENDING_INVITES}). Revoke some first.`);
      }

      const token = randomBytes(32).toString("base64url");
      const invitationId = randomUUID();
      await tx.insert(organizationInvitations).values({
        id: invitationId,
        tenantId: input.orgId,
        email,
        role,
        tokenHash: hashToken(token),
        invitedBy: input.actorUserId,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      });
      await recordAudit(tx, {
        tenantId: input.orgId,
        actorType: "user",
        actorId: input.actorUserId,
        action: "org.invitation.create",
        target: `invitation:${invitationId}`,
        outcome: "success",
        metadata: { email, role },
      });

      const acceptUrl = acceptUrlFor(input.orgId, token);
      const mailed = await getMailSender()
        .send({
          to: email,
          subject: "You've been invited to Scout OS",
          text: `You've been invited to join an organization on Scout OS as ${role}.\n\nAccept the invitation: ${acceptUrl}\n\nThis link expires in 7 days. If you weren't expecting this, ignore it.`,
        })
        .then(
          () => true,
          (err) => {
            logger.warn({ orgId: input.orgId, invitationId, err }, "invitation email failed; link returned to inviter");
            return false;
          },
        );
      logger.info({ orgId: input.orgId, actor: input.actorUserId, invitationId, role, emailed: mailed }, "invitation created");
      return { kind: "invitation", invitationId, acceptUrl, emailed: mailed };
    }),
  );
}

export async function listMembers(input: { actorUserId: string; orgId: string }): Promise<Member[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "org.listMembers");
    const rows = await tx
      .select({
        userId: organizationMembers.userId,
        name: users.name,
        email: users.email,
        role: organizationMembers.role,
        joinedAt: organizationMembers.createdAt,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.tenantId, input.orgId))
      .orderBy(asc(organizationMembers.createdAt));
    return rows;
  });
}

export async function listMyOrgs(input: { actorUserId: string }): Promise<MyOrg[]> {
  return withUser(input.actorUserId, (tx) =>
    tx
      .select({ orgId: organizations.id, name: organizations.name, role: organizationMembers.role })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.tenantId))
      .where(eq(organizationMembers.userId, input.actorUserId))
      .orderBy(asc(organizations.name)),
  );
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  status: (typeof organizationInvitations.status.enumValues)[number];
  expiresAt: Date;
  createdAt: Date;
}

const tokenSchema = z.string().min(10).max(200);
const userIdSchema = z.string().min(1).max(64);

/** Marks pending invitations past their expiry as expired. Returns nothing; cheap enough to run on every read path. */
async function expireOverdue(tx: Tx, orgId: string): Promise<void> {
  await tx
    .update(organizationInvitations)
    .set({ status: "expired" })
    .where(
      and(
        eq(organizationInvitations.tenantId, orgId),
        eq(organizationInvitations.status, "pending"),
        lt(organizationInvitations.expiresAt, new Date()),
      ),
    );
}

/** Lists invitations (never the token hash). Managers only. */
export async function listInvitations(input: { actorUserId: string; orgId: string }): Promise<Invitation[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "org.listInvitations");
    await expireOverdue(tx, input.orgId);
    return tx
      .select({
        id: organizationInvitations.id,
        email: organizationInvitations.email,
        role: organizationInvitations.role,
        status: organizationInvitations.status,
        expiresAt: organizationInvitations.expiresAt,
        createdAt: organizationInvitations.createdAt,
      })
      .from(organizationInvitations)
      .where(eq(organizationInvitations.tenantId, input.orgId))
      .orderBy(desc(organizationInvitations.createdAt));
  });
}

export async function revokeInvitation(input: { actorUserId: string; orgId: string; invitationId: string }): Promise<{ invitationId: string }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "org.invitation.revoke");
    const rows = await tx
      .select({ id: organizationInvitations.id, status: organizationInvitations.status })
      .from(organizationInvitations)
      .where(and(eq(organizationInvitations.tenantId, input.orgId), eq(organizationInvitations.id, input.invitationId)));
    const inv = rows[0];
    if (!inv) throw new AppError("NOT_FOUND", "Invitation not found");
    if (inv.status !== "pending") throw new AppError("CONFLICT", `Invitation is already ${inv.status}`);
    await tx.update(organizationInvitations).set({ status: "revoked" }).where(eq(organizationInvitations.id, inv.id));
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "org.invitation.revoke",
      target: `invitation:${inv.id}`,
      outcome: "success",
    });
    logger.info({ orgId: input.orgId, actor: input.actorUserId, invitationId: inv.id }, "invitation revoked");
    return { invitationId: inv.id };
  });
}

/**
 * Accepts an invitation link. The URL carries the org id because RLS fails
 * closed: without tenant context the token lookup would see zero rows. The
 * signed-in user's email must match the invited address; the error never
 * reveals which address was invited.
 */
export async function acceptInvitation(input: { actorUserId: string; orgId: string; token: string }): Promise<{ orgId: string; role: Role }> {
  const token = parse(tokenSchema, input.token);
  return withSpan("org.invitation.accept", { "org.id": input.orgId }, () =>
    inOrg(input.orgId, async (tx) => {
      await expireOverdue(tx, input.orgId);
      const rows = await tx
        .select()
        .from(organizationInvitations)
        .where(
          and(
            eq(organizationInvitations.tenantId, input.orgId),
            eq(organizationInvitations.tokenHash, hashToken(token)),
            eq(organizationInvitations.status, "pending"),
          ),
        );
      const inv = rows[0];
      if (!inv) throw new AppError("NOT_FOUND", "That invitation link is invalid or has already been used");

      const me = await withGlobal((tx2) => tx2.select({ email: users.email }).from(users).where(eq(users.id, input.actorUserId)));
      const myEmail = me[0]?.email;
      if (!myEmail || myEmail.toLowerCase() !== inv.email.toLowerCase()) {
        await auditDenied(input.orgId, input.actorUserId, "org.invitation.accept", { reason: "email_mismatch", invitationId: inv.id });
        throw new AppError("FORBIDDEN", "This invitation was sent to a different email address");
      }
      if (await roleOf(tx, input.orgId, input.actorUserId)) throw new AppError("CONFLICT", "You are already a member of this organization");

      // Seats are counted at accept time: an invitation created under the cap can still land on a full org.
      await assertSeatAvailable(tx, input.orgId, input.actorUserId);
      await tx.insert(organizationMembers).values({ tenantId: input.orgId, userId: input.actorUserId, role: inv.role });
      await tx
        .update(organizationInvitations)
        .set({ status: "accepted", acceptedBy: input.actorUserId, acceptedAt: new Date() })
        .where(eq(organizationInvitations.id, inv.id));
      await recordAudit(tx, {
        tenantId: input.orgId,
        actorType: "user",
        actorId: input.actorUserId,
        action: "org.invitation.accept",
        target: `invitation:${inv.id}`,
        outcome: "success",
        metadata: { role: inv.role },
      });
      logger.info({ orgId: input.orgId, actor: input.actorUserId, invitationId: inv.id, role: inv.role }, "invitation accepted");
      return { orgId: input.orgId, role: inv.role };
    }),
  );
}

async function countOwners(tx: Tx, orgId: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.tenantId, orgId), eq(organizationMembers.role, "owner")));
  return row?.count ?? 0;
}

/**
 * Removes a member. Owners/admins can only be removed by an owner; the last
 * owner can never be removed (transfer ownership first). Audited at tier 4.
 */
export async function removeMember(input: { actorUserId: string; orgId: string; userId: string }): Promise<{ userId: string }> {
  const userId = parse(userIdSchema, input.userId);
  return withSpan("org.member.remove", { "org.id": input.orgId }, () =>
    inOrg(input.orgId, async (tx) => {
      const actorRole = await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "org.member.remove");
      const targetRole = await roleOf(tx, input.orgId, userId);
      if (!targetRole) throw new AppError("NOT_FOUND", "That person is not a member of this organization");
      if ((targetRole === "owner" || targetRole === "admin") && actorRole !== "owner") {
        await auditDenied(input.orgId, input.actorUserId, "org.member.remove", { reason: "admin_cannot_remove_staff", target: userId });
        throw new AppError("FORBIDDEN", "Only an owner can remove an owner or admin");
      }
      if (targetRole === "owner" && (await countOwners(tx, input.orgId)) <= 1) {
        throw new AppError("CONFLICT", "The last owner can't be removed. Transfer ownership first.");
      }
      await tx
        .delete(organizationMembers)
        .where(and(eq(organizationMembers.tenantId, input.orgId), eq(organizationMembers.userId, userId)));
      await recordAudit(tx, {
        tenantId: input.orgId,
        actorType: "user",
        actorId: input.actorUserId,
        action: "org.member.remove",
        target: `user:${userId}`,
        tier: 4,
        outcome: "success",
        metadata: { removedRole: targetRole },
      });
      logger.info({ orgId: input.orgId, actor: input.actorUserId, member: userId }, "member removed");
      return { userId };
    }),
  );
}

/**
 * Changes a member's role. Only an owner can grant or revoke owner/admin;
 * admins may toggle between member and viewer. Demoting the last owner is
 * refused so the org is never left without one.
 */
export async function setMemberRole(input: { actorUserId: string; orgId: string; userId: string; role: string }): Promise<{ userId: string; role: Role }> {
  const userId = parse(userIdSchema, input.userId);
  const role = parse(z.enum(ROLES), input.role);
  return withSpan("org.member.setRole", { "org.id": input.orgId }, () =>
    inOrg(input.orgId, async (tx) => {
      const actorRole = await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "org.member.setRole");
      const targetRole = await roleOf(tx, input.orgId, userId);
      if (!targetRole) throw new AppError("NOT_FOUND", "That person is not a member of this organization");
      if (targetRole === role) return { userId, role };

      const touchesStaff = targetRole === "owner" || targetRole === "admin" || role === "owner" || role === "admin";
      if (touchesStaff && actorRole !== "owner") {
        await auditDenied(input.orgId, input.actorUserId, "org.member.setRole", { reason: "admin_cannot_change_staff", target: userId });
        throw new AppError("FORBIDDEN", "Only an owner can change owner or admin roles");
      }
      if (targetRole === "owner" && role !== "owner" && (await countOwners(tx, input.orgId)) <= 1) {
        throw new AppError("CONFLICT", "The last owner can't be demoted. Make someone else an owner first.");
      }
      await tx
        .update(organizationMembers)
        .set({ role })
        .where(and(eq(organizationMembers.tenantId, input.orgId), eq(organizationMembers.userId, userId)));
      await recordAudit(tx, {
        tenantId: input.orgId,
        actorType: "user",
        actorId: input.actorUserId,
        action: "org.member.setRole",
        target: `user:${userId}`,
        tier: 3,
        outcome: "success",
        metadata: { from: targetRole, to: role },
      });
      logger.info({ orgId: input.orgId, actor: input.actorUserId, member: userId, from: targetRole, to: role }, "member role changed");
      return { userId, role };
    }),
  );
}
