import { and, eq } from "drizzle-orm";
import { emailIdentities, integrationConnections, withTenant } from "@wos/db";
import { logger } from "../logger";
import { readSecret, updateSecret } from "../integrations/connections";
import { GmailProvider, type GoogleTokens } from "../integrations/gmail";
import type { MailProvider } from "../integrations/mail";

export interface Mailbox {
  provider: MailProvider;
  identity: typeof emailIdentities.$inferSelect;
}

/** Resolves a tenant's mailbox. Injected so tests can supply the MOCK provider. */
export type MailboxResolver = (tenantId: string) => Promise<Mailbox | null>;

/** Production resolver: the tenant's active Google connection, tokens decrypted for this call only. */
export const gmailMailboxResolver: MailboxResolver = async (tenantId) => {
  const found = await withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ identity: emailIdentities, connection: integrationConnections })
      .from(emailIdentities)
      .innerJoin(integrationConnections, eq(integrationConnections.id, emailIdentities.integrationConnectionId))
      .where(and(eq(integrationConnections.provider, "google"), eq(integrationConnections.status, "active")))
      .limit(1);
    return row;
  });
  if (!found) return null;
  const tokens = readSecret<GoogleTokens>(found.connection);
  const provider = GmailProvider.fromTokens(tokens, found.identity.address, async (fresh) => {
    // Google rotated the access token; keep the refresh token we already had.
    await withTenant(tenantId, (tx) => updateSecret(tx, found.connection, { ...tokens, ...fresh, refresh_token: fresh.refresh_token ?? tokens.refresh_token }));
    logger.info({ tenantId, connectionId: found.connection.id }, "google tokens refreshed");
  });
  return { provider, identity: found.identity };
};
