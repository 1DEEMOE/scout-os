import { and, eq } from "drizzle-orm";
import { integrationConnections, withTenant } from "@wos/db";
import { readSecret } from "../integrations/connections";
import type { CrmProvider } from "../integrations/crm";
import { HubSpotProvider } from "../integrations/hubspot";

/** Resolves a tenant's CRM. Injected so tests can supply the MOCK provider. */
export type CrmResolver = (tenantId: string) => Promise<CrmProvider | null>;

export const hubspotCrmResolver: CrmResolver = async (tenantId) => {
  const [conn] = await withTenant(tenantId, (tx) =>
    tx.select().from(integrationConnections).where(and(eq(integrationConnections.provider, "hubspot"), eq(integrationConnections.status, "active"))).limit(1),
  );
  if (!conn) return null;
  return new HubSpotProvider(readSecret<{ accessToken: string }>(conn).accessToken);
};
