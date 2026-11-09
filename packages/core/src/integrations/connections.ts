import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { emailIdentities, integrationConnections, isUuid, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { logger } from "../logger";
import { ANY_ROLE, inOrg, MANAGERS, requireRole } from "../org/access";
import { currentSecretKeyId, decryptSecret, encryptSecret } from "../secrets";

export type ConnectionRow = typeof integrationConnections.$inferSelect;

/** Creates or replaces a connection's credentials, encrypted and bound to (tenant, connection). */
export async function upsertConnection(
  tx: Tx,
  c: { tenantId: string; provider: ConnectionRow["provider"]; accountLabel: string; scopes: string[]; secret: unknown; createdBy: string },
): Promise<ConnectionRow> {
  const [existing] = await tx
    .select()
    .from(integrationConnections)
    .where(and(eq(integrationConnections.provider, c.provider), eq(integrationConnections.accountLabel, c.accountLabel)));
  const id = existing?.id ?? randomUUID();
  const secretCiphertext = encryptSecret(c.secret, { tenantId: c.tenantId, connectionId: id });
  if (existing) {
    const [row] = await tx
      .update(integrationConnections)
      .set({ secretCiphertext, secretRef: currentSecretKeyId(), scopes: c.scopes, status: "active", updatedAt: new Date() })
      .where(eq(integrationConnections.id, id))
      .returning();
    return row!;
  }
  const [row] = await tx
    .insert(integrationConnections)
    .values({ id, tenantId: c.tenantId, provider: c.provider, accountLabel: c.accountLabel, scopes: c.scopes, secretRef: currentSecretKeyId(), secretCiphertext, createdBy: c.createdBy })
    .returning();
  return row!;
}

export function readSecret<T>(row: Pick<ConnectionRow, "tenantId" | "id" | "secretCiphertext">): T {
  return decryptSecret<T>(row.secretCiphertext, { tenantId: row.tenantId, connectionId: row.id });
}

export async function updateSecret(tx: Tx, row: Pick<ConnectionRow, "tenantId" | "id">, secret: unknown): Promise<void> {
  await tx
    .update(integrationConnections)
    .set({ secretCiphertext: encryptSecret(secret, { tenantId: row.tenantId, connectionId: row.id }), updatedAt: new Date() })
    .where(eq(integrationConnections.id, row.id));
}

/** Connection list for the UI: never includes the ciphertext. */
export async function listConnectionsSafe(tx: Tx) {
  return tx
    .select({
      id: integrationConnections.id,
      provider: integrationConnections.provider,
      accountLabel: integrationConnections.accountLabel,
      scopes: integrationConnections.scopes,
      status: integrationConnections.status,
      updatedAt: integrationConnections.updatedAt,
    })
    .from(integrationConnections);
}

/** For the settings page. Never returns credentials. */
export async function listIntegrations(input: { actorUserId: string; orgId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "integration.list");
    return listConnectionsSafe(tx);
  });
}

/**
 * Removes a connection and its credentials. Dependent mailboxes are deleted
 * too, which stops their background sync chain (the next scheduled job finds
 * no identity and does not re-enqueue). Audited at tier 4.
 */
export async function disconnectIntegration(input: { actorUserId: string; orgId: string; connectionId: string }): Promise<{ connectionId: string }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "integration.disconnect");
    const [conn] = isUuid(input.connectionId)
      ? await tx.select().from(integrationConnections).where(eq(integrationConnections.id, input.connectionId))
      : [];
    if (!conn) throw new AppError("NOT_FOUND", "Connection not found");
    await tx.delete(emailIdentities).where(eq(emailIdentities.integrationConnectionId, conn.id));
    await tx.delete(integrationConnections).where(eq(integrationConnections.id, conn.id));
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "integration.disconnect",
      target: `integration:${conn.id}`,
      tier: 4,
      outcome: "success",
      metadata: { provider: conn.provider, accountLabel: conn.accountLabel },
    });
    logger.info({ orgId: input.orgId, actor: input.actorUserId, connectionId: conn.id, provider: conn.provider }, "integration disconnected");
    return { connectionId: conn.id };
  });
}
