import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { contacts, crmRecords, withTenant } from "@wos/db";
import { produceIntegration } from "../events/produce";
import { objectResult, ToolError, type ToolContext, type ToolDefinition, type ToolRegistry } from "../engine/tools";
import type { CrmResolver } from "../crm/resolver";

export const DEAL_STAGES = ["appointmentscheduled", "qualifiedtobuy", "presentationscheduled", "decisionmakerboughtin", "contractsent", "closedwon", "closedlost"] as const;
const email = z.email().transform((e) => e.toLowerCase());
const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

async function crmFor(resolve: CrmResolver, ctx: ToolContext) {
  const crm = await resolve(ctx.tenantId);
  if (!crm) throw new ToolError("No CRM is connected", false, "NO_CRM");
  return crm;
}

async function contactByEmail(ctx: ToolContext, address: string) {
  return withTenant(ctx.tenantId, async (tx) => (await tx.select().from(contacts).where(sql`lower(${contacts.email}) = ${address}`))[0]);
}

async function dealById(ctx: ToolContext, id: string) {
  const [d] = await withTenant(ctx.tenantId, (tx) => tx.select().from(crmRecords).where(eq(crmRecords.id, id)));
  if (!d) throw new ToolError("Deal not found", false, "NOT_FOUND");
  return d;
}

export function crmTools(resolve: CrmResolver): ToolDefinition[] {
  const upsertContact: ToolDefinition<{ email: string; name?: string; phone?: string; company?: string }> = {
    name: "crm.upsert_contact",
    description: "Create or update a contact in the CRM, matched by email.",
    tier: 1,
    output: objectResult,
    args: z.object({ email, name: z.string().max(200).optional(), phone: z.string().max(40).optional(), company: z.string().max(200).optional() }),
    summarize: (a) => `Save contact ${a.email}`,
    async execute(ctx, a) {
      const crm = await crmFor(resolve, ctx);
      const { externalId } = await produceIntegration({
        tenantId: ctx.tenantId,
        integration: "crm",
        idempotencyKey: `crm-contact:${ctx.idempotencyKey}`,
        retry: async () => {
          const again = await crm.upsertContact(a);
          return { externalId: again.externalId, mock: true };
        },
        effect: (fx) => fx.once(() => crm.upsertContact(a)),
      });
      const contactId = await withTenant(ctx.tenantId, async (tx) => {
        const [existing] = await tx.select().from(contacts).where(sql`lower(${contacts.email}) = ${a.email}`);
        if (existing) {
          await tx.update(contacts).set({ name: a.name ?? existing.name, phone: a.phone ?? existing.phone, company: a.company ?? existing.company, externalId, updatedAt: new Date() }).where(eq(contacts.id, existing.id));
          return existing.id;
        }
        const [row] = await tx.insert(contacts).values({ tenantId: ctx.tenantId, email: a.email, name: a.name ?? "", phone: a.phone, company: a.company, source: "agent", externalId }).returning({ id: contacts.id });
        return row!.id;
      });
      return { contactId, externalId, mock: crm.mock };
    },
  };

  const createDeal: ToolDefinition<{ name: string; contactEmail: string; stage: (typeof DEAL_STAGES)[number] }> = {
    name: "crm.create_deal",
    description: "Open a new deal for a contact (no amount; amounts need a separate, higher-risk step).",
    tier: 1,
    output: objectResult,
    args: z.object({ name: z.string().trim().min(1).max(200), contactEmail: email, stage: z.enum(DEAL_STAGES).default("appointmentscheduled") }),
    summarize: (a) => `Open deal "${a.name}" for ${a.contactEmail}`,
    async execute(ctx, a) {
      const crm = await crmFor(resolve, ctx);
      const contact = await contactByEmail(ctx, a.contactEmail);
      if (!contact) throw new ToolError(`No contact with email ${a.contactEmail}; save the contact first`, false, "NO_CONTACT");
      const { externalId } = await produceIntegration({
        tenantId: ctx.tenantId,
        integration: "crm",
        idempotencyKey: `crm-deal:${ctx.idempotencyKey}`,
        effect: (fx) => fx.once(() => crm.createDeal({ name: a.name, stage: a.stage, contactExternalId: contact.externalId ?? undefined }, ctx.idempotencyKey)),
      });
      return recordDeal(ctx, crm.name, externalId, contact.id, a);
    },
    async reconcile(ctx, a) {
      const crm = await crmFor(resolve, ctx);
      const found = await crm.findDealByKey(ctx.idempotencyKey);
      if (!found) return undefined;
      const contact = await contactByEmail(ctx, a.contactEmail);
      return recordDeal(ctx, crm.name, found.externalId, contact?.id ?? null, a);
    },
  };

  const updateStage: ToolDefinition<{ dealId: string; stage: (typeof DEAL_STAGES)[number] }> = {
    name: "crm.update_deal_stage",
    description: "Move a deal to another pipeline stage.",
    tier: 2,
    output: objectResult,
    args: z.object({ dealId: z.uuid(), stage: z.enum(DEAL_STAGES) }),
    summarize: (a) => `Move deal ${a.dealId.slice(0, 8)} to ${a.stage}`,
    async execute(ctx, a) {
      const crm = await crmFor(resolve, ctx);
      const deal = await dealById(ctx, a.dealId);
      await crm.updateDeal(deal.externalId, { stage: a.stage });
      await withTenant(ctx.tenantId, (tx) => tx.update(crmRecords).set({ stage: a.stage, syncedAt: new Date() }).where(eq(crmRecords.id, deal.id)));
      return { dealId: deal.id, stage: a.stage };
    },
  };

  const setAmount: ToolDefinition<{ dealId: string; amountCents: number }> = {
    name: "crm.set_deal_amount",
    description: "Set a deal's amount. A pricing commitment, so it always needs a human.",
    tier: 3,
    output: objectResult,
    args: z.object({ dealId: z.uuid(), amountCents: z.number().int().min(0).max(100_000_000_00) }),
    summarize: (a) => `Set deal ${a.dealId.slice(0, 8)} amount to ${money(a.amountCents)}`,
    async execute(ctx, a) {
      const crm = await crmFor(resolve, ctx);
      const deal = await dealById(ctx, a.dealId);
      await crm.updateDeal(deal.externalId, { amountCents: a.amountCents });
      await withTenant(ctx.tenantId, (tx) => tx.update(crmRecords).set({ amountCents: a.amountCents, syncedAt: new Date() }).where(eq(crmRecords.id, deal.id)));
      return { dealId: deal.id, amountCents: a.amountCents };
    },
  };

  const addNote: ToolDefinition<{ contactEmail: string; body: string }> = {
    name: "crm.add_note",
    description: "Add a note to a contact's CRM timeline.",
    tier: 1,
    output: objectResult,
    args: z.object({ contactEmail: email, body: z.string().trim().min(1).max(5000) }),
    summarize: (a) => `Add a note to ${a.contactEmail}`,
    async execute(ctx, a) {
      const crm = await crmFor(resolve, ctx);
      const contact = await contactByEmail(ctx, a.contactEmail);
      if (!contact?.externalId) throw new ToolError(`No synced contact with email ${a.contactEmail}`, false, "NO_CONTACT");
      return crm.addNote(contact.externalId, a.body, ctx.idempotencyKey);
    },
  };

  return [upsertContact, createDeal, updateStage, setAmount, addNote] as ToolDefinition[];
}

async function recordDeal(ctx: ToolContext, provider: "hubspot" | "fake", externalId: string, contactId: string | null, a: { name: string; stage: string }) {
  return withTenant(ctx.tenantId, async (tx) => {
    await tx.insert(crmRecords).values({ tenantId: ctx.tenantId, contactId, provider, externalId, name: a.name, stage: a.stage }).onConflictDoNothing();
    const [row] = await tx.select().from(crmRecords).where(and(eq(crmRecords.provider, provider), eq(crmRecords.externalId, externalId)));
    return { dealId: row!.id, externalId };
  });
}

export function registerCrmTools(registry: ToolRegistry, resolve: CrmResolver): void {
  registry.register(...crmTools(resolve));
}
