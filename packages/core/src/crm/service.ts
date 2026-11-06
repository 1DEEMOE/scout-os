import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { contacts, crmRecords } from "@wos/db";
import { recordAudit } from "../audit";
import { createTask } from "../engine/tasks";
import { upsertConnection } from "../integrations/connections";
import { getConversation } from "../inbox/service";
import { ANY_ROLE, inOrg, MANAGERS, requireRole } from "../org/access";

/** Stores a HubSpot private-app token, encrypted. Owners and admins only. */
export async function connectHubSpot(input: { actorUserId: string; orgId: string; accessToken: string; label: string }) {
  const token = z.string().trim().min(10).max(500).parse(input.accessToken);
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "integration.connect");
    const conn = await upsertConnection(tx, { tenantId: input.orgId, provider: "hubspot", accountLabel: input.label.slice(0, 120), scopes: [], secret: { accessToken: token }, createdBy: input.actorUserId });
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "integration.connect", target: `integration:${conn.id}`, tier: 4, outcome: "success", metadata: { provider: "hubspot" } });
    return { connectionId: conn.id };
  });
}

export async function listContacts(input: { actorUserId: string; orgId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "crm.list");
    return tx.select().from(contacts).orderBy(desc(contacts.updatedAt)).limit(200);
  });
}

export async function listDeals(input: { actorUserId: string; orgId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "crm.list");
    return tx
      .select({ deal: crmRecords, contactEmail: contacts.email, contactName: contacts.name })
      .from(crmRecords)
      .leftJoin(contacts, eq(contacts.id, crmRecords.contactId))
      .orderBy(desc(crmRecords.createdAt))
      .limit(200);
  });
}

/** Hands an inbound email to the sales agent: save the lead, open a deal, draft a follow-up. */
export async function qualifyLead(input: { actorUserId: string; orgId: string; conversationId: string }) {
  const { conversation, messages } = await getConversation(input);
  const recent = messages.slice(-5).map((m) => ({ direction: m.direction, from: m.sender, body: m.body.slice(0, 4000) }));
  return createTask({
    actorUserId: input.actorUserId,
    orgId: input.orgId,
    title: `Sales lead from email: ${conversation.subject || "(no subject)"}`,
    intent:
      "Treat this email as a sales lead: save the sender with crm.upsert_contact, open a deal with crm.create_deal, " +
      `note the request with crm.add_note, and draft a follow-up reply with inbox.create_draft. Conversation id: ${conversation.id}`,
    input: { agentKind: "sales", conversationId: conversation.id, subject: conversation.subject, messages: recent },
  });
}
