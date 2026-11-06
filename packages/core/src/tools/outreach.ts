/**
 * scout.send_outreach: Scout's first email to a prospect. Tier 2 (external
 * communication) and owner-only, so it always waits for an owner's OK. At send
 * time it re-checks the do-not-contact list and recorded permission, so neither
 * an approval nor a stale draft can get around them. Idempotent through the
 * step's Message-ID.
 */
import { z } from "zod";
import { opportunities, withTenant } from "@wos/db";
import { eq } from "drizzle-orm";
import { SCOUT_OUTREACH_TOOL } from "../engine/owner-only";
import { ToolError, type ToolDefinition, type ToolRegistry } from "../engine/tools";
import type { MailboxResolver } from "../inbox/mailbox";
import { messageIdFor } from "../integrations/mail";
import { checkEmailAllowed, recordOutreach } from "../scout/consent";

type Args = { opportunityId: string; to: string; subject: string; body: string };

export function outreachTools(mailbox: MailboxResolver): ToolDefinition[] {
  const send: ToolDefinition<Args> = {
    name: SCOUT_OUTREACH_TOOL,
    description: "Send Scout's first email to a prospect. An owner approves the exact message first.",
    tier: 2,
    args: z.object({ opportunityId: z.uuid(), to: z.email(), subject: z.string().min(3).max(200), body: z.string().min(20).max(5000) }),
    summarize: (a) => `Send a first email to ${a.to}: "${a.subject}"`,
    async execute(ctx, a) {
      const box = await mailbox(ctx.tenantId);
      if (!box) throw new ToolError("No email account is connected, so nothing was sent. Connect Gmail in Settings, then ask again.", false, "NO_MAILBOX");
      if (box.identity.mode !== "send_with_approval") throw new ToolError("This mailbox is in draft-only mode. An owner can allow sending in Settings.", false, "DRAFT_ONLY");
      const gate = await withTenant(ctx.tenantId, async (tx) => {
        const [o] = await tx.select({ id: opportunities.id }).from(opportunities).where(eq(opportunities.id, a.opportunityId));
        if (!o) return { allowed: false as const, message: "That opportunity no longer exists.", reason: "missing" };
        const g = await checkEmailAllowed(tx, [a.to]);
        if (!g.allowed) await recordOutreach(tx, { tenantId: ctx.tenantId, opportunityId: a.opportunityId, recipient: g.recipient, kind: "blocked", reason: g.reason, actor: { type: "agent", id: ctx.agentId }, ref: `task:${ctx.taskId}` });
        return g;
      });
      if (!gate.allowed) throw new ToolError(gate.message, false, "reason" in gate && gate.reason === "suppressed" ? "SUPPRESSED" : "NO_PERMISSION");
      const messageId = messageIdFor(ctx.idempotencyKey);
      const existing = await box.provider.findSent(messageId);
      if (existing) return { externalId: existing.externalId, to: [a.to], mock: box.provider.mock };
      const { draftId } = (await box.provider.findDraft(messageId)) ?? (await box.provider.createDraft({ to: [a.to], subject: a.subject, body: a.body, messageId }));
      const { externalId } = await box.provider.sendDraft(draftId);
      await withTenant(ctx.tenantId, (tx) => recordOutreach(tx, { tenantId: ctx.tenantId, opportunityId: a.opportunityId, recipient: a.to, kind: "sent", actor: { type: "agent", id: ctx.agentId }, ref: externalId }));
      return { externalId, to: [a.to], mock: box.provider.mock };
    },
    async reconcile(ctx) {
      const box = await mailbox(ctx.tenantId);
      if (!box) return undefined;
      const sent = await box.provider.findSent(messageIdFor(ctx.idempotencyKey));
      return sent ? { externalId: sent.externalId } : undefined;
    },
  };
  return [send] as ToolDefinition[];
}

export function registerOutreachTools(registry: ToolRegistry, mailbox: MailboxResolver): void {
  registry.register(...outreachTools(mailbox));
}
