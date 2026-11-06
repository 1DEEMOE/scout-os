/**
 * Approvals only an OWNER may decide (admins see them read-only).
 * Tightens the existing rules; never loosens them:
 *  - any bank / remittance detail change (tier 3+, call-back still required),
 *  - an invoice or estimate held because it looks forged (never auto-paid),
 *  - Scout's first outreach to a prospect ("goes out only after the owner approves").
 * Tier 4 still also needs a second confirmation from a different owner.
 */
import { FORGERY_REVIEW_TOOL } from "../documents/forgery";
import { PAYMENT_DETAIL_TOOLS } from "../finance/payment-guard";

export const SCOUT_OUTREACH_TOOL = "scout.send_outreach";

export const OWNER_ONLY_TOOLS: ReadonlySet<string> = new Set([...PAYMENT_DETAIL_TOOLS, FORGERY_REVIEW_TOOL, SCOUT_OUTREACH_TOOL]);

export function isOwnerOnly(toolName: string): boolean {
  return OWNER_ONLY_TOOLS.has(toolName);
}

export function ownerOnlyReason(toolName: string): string {
  if (PAYMENT_DETAIL_TOOLS.has(toolName)) return "Only an owner can approve a change to bank or payment details.";
  if (toolName === FORGERY_REVIEW_TOOL) return "Only an owner can release an invoice held as possibly forged.";
  return "Only an owner can approve Scout's first message to a new prospect.";
}
