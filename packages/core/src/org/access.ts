import { and, eq } from "drizzle-orm";
import { InvalidTenantError, organizationMembers, withTenant, withTenantOutOfBand, type Role, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { logger } from "../logger";

export const STAFF: readonly Role[] = ["owner", "admin", "member"];
export const MANAGERS: readonly Role[] = ["owner", "admin"];
export const ANY_ROLE: readonly Role[] = ["owner", "admin", "member", "viewer"];

/** withTenant for a caller-supplied org id: a malformed id is just "not found". */
export async function inOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await withTenant(orgId, fn);
  } catch (err) {
    if (err instanceof InvalidTenantError) throw new AppError("NOT_FOUND", "Organization not found");
    throw err;
  }
}

export async function roleOf(tx: Tx, tenantId: string, userId: string): Promise<Role | null> {
  const rows = await tx
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.tenantId, tenantId), eq(organizationMembers.userId, userId)));
  return rows[0]?.role ?? null;
}

/**
 * Records a denied action in its own transaction. The caller's transaction is
 * about to roll back when it throws, which would otherwise erase this entry.
 */
export async function auditDenied(tenantId: string, actorUserId: string, action: string, metadata: Record<string, unknown>): Promise<void> {
  await withTenantOutOfBand(tenantId, (tx) =>
    recordAudit(tx, { tenantId, actorType: "user", actorId: actorUserId, action, outcome: "denied", metadata }),
  );
  logger.warn({ tenantId, actor: actorUserId, action, ...metadata }, "action denied");
}

/** Throws unless the actor is a member with one of the allowed roles. Non-members get NOT_FOUND. */
export async function requireRole(tx: Tx, tenantId: string, actorUserId: string, allowed: readonly Role[], action: string): Promise<Role> {
  const role = await roleOf(tx, tenantId, actorUserId);
  if (!role || !allowed.includes(role)) {
    if (role) await auditDenied(tenantId, actorUserId, action, { role });
    // Non-members don't belong in the tenant's audit log, but probes are still logged.
    else logger.warn({ tenantId, actor: actorUserId, action }, "non-member access attempt");
    throw new AppError(role ? "FORBIDDEN" : "NOT_FOUND", role ? "You don't have permission to do that" : "Organization not found");
  }
  return role;
}
