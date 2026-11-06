import { agents } from "@wos/db";
import { inOrg, MANAGERS, requireRole } from "../org/access";
import { createAgent, type AgentSpec } from "./agents";

/**
 * Recommended starting agents. Tool tiers here are the agent's ceilings; the
 * policy still requires approval for every tier 2+ action they propose.
 */
export const AGENT_PRESETS: AgentSpec[] = [
  {
    kind: "inbox",
    displayName: "Inbox",
    instructions:
      "You manage the business inbox. Categorize each conversation and write a short, factual summary. " +
      "Draft replies that are polite, brief and specific; never promise prices, dates or refunds unless the business user's request states them.",
    tools: [
      { name: "inbox.categorize", maxTier: 1 },
      { name: "inbox.create_draft", maxTier: 1 },
      { name: "inbox.send_draft", maxTier: 2 },
      { name: "memory.note", maxTier: 1 },
      { name: "memory.propose_fact", maxTier: 2 },
    ],
  },
  {
    kind: "sales",
    displayName: "Pipeline",
    instructions:
      "You turn inbound interest into organized CRM records: save the contact, open a deal at the first stage, add a note with what they asked for, " +
      "and draft a friendly follow-up. Never set deal amounts unless the business user's request gives the number.",
    tools: [
      { name: "crm.upsert_contact", maxTier: 1 },
      { name: "crm.create_deal", maxTier: 1 },
      { name: "crm.add_note", maxTier: 1 },
      { name: "crm.update_deal_stage", maxTier: 2 },
      { name: "crm.set_deal_amount", maxTier: 3 },
      { name: "inbox.create_draft", maxTier: 1 },
      { name: "memory.note", maxTier: 1 },
      { name: "memory.propose_fact", maxTier: 2 },
    ],
  },
  {
    kind: "finance",
    displayName: "Billing",
    instructions:
      "You keep receivables current. For overdue invoices, propose one reminder each, skipping any reminded in the last 7 days. " +
      "Only create or void invoices when the business user's request explicitly asks, with the exact amounts given.",
    tools: [
      { name: "finance.send_invoice_reminder", maxTier: 2 },
      { name: "finance.create_invoice", maxTier: 3 },
      { name: "finance.void_invoice", maxTier: 3 },
      { name: "finance.update_payment_destination", maxTier: 3 },
      { name: "finance.request_payment_with_new_destination", maxTier: 3 },
      { name: "memory.note", maxTier: 1 },
    ],
  },
];

/**
 * Scout: deterministic matching and scoring. Only on plans with Scout; created
 * when a manager reviews the business profile, not by "add recommended agents".
 */
export const SCOUT_PRESET: AgentSpec = {
  kind: "scout",
  displayName: "Scout",
  instructions:
    "You find possible opportunities by matching the business's own prospect records against public storm reports in its reviewed service area. " +
    "You score with fixed rules and explain every score. You never contact anyone and never claim a property is damaged.",
  tools: [{ name: "scout.scan", maxTier: 1 }],
};

/** Creates any recommended agents the org doesn't have yet. Owners and admins only. */
export async function provisionRecommendedAgents(input: { actorUserId: string; orgId: string }): Promise<{ created: string[] }> {
  const existing = await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "agent.provision");
    return (await tx.select({ kind: agents.kind }).from(agents)).map((a) => a.kind);
  });
  const created: string[] = [];
  for (const spec of AGENT_PRESETS) {
    if (existing.includes(spec.kind)) continue;
    await createAgent({ actorUserId: input.actorUserId, orgId: input.orgId, spec });
    created.push(spec.kind);
  }
  return { created };
}
