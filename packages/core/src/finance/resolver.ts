import { and, eq } from "drizzle-orm";
import { integrationConnections, withTenant } from "@wos/db";
import { readSecret } from "../integrations/connections";
import type { InvoicingProvider } from "../integrations/invoicing";
import { StripeInvoicingProvider } from "../integrations/stripe-invoicing";

export type InvoicingResolver = (tenantId: string) => Promise<InvoicingProvider | null>;

export const stripeInvoicingResolver: InvoicingResolver = async (tenantId) => {
  const [conn] = await withTenant(tenantId, (tx) =>
    tx.select().from(integrationConnections).where(and(eq(integrationConnections.provider, "stripe"), eq(integrationConnections.status, "active"))).limit(1),
  );
  if (!conn) return null;
  return new StripeInvoicingProvider(readSecret<{ secretKey: string }>(conn).secretKey);
};
