/**
 * Approval-card presentation. This does not decide policy.
 * Tier 2+ still needs a person. Always-allow never covers money, irreversible, or tier >= 2.
 */

export type WarningBadge = "can't be undone" | "goes to a customer" | "money";

export interface ApprovalCardView {
  line: string;
  facts: { label: string; value: string }[];
  badges: WarningBadge[];
  /** Always-allow may only be saved when this is null. */
  alwaysAllowBlocked: string | null;
  suggestedRule: string | null;
  background: boolean;
  expiresInMinutes: number | null;
}

const MONEY = /invoice|payment|payee|charge|refund|destination/i;
const CUSTOMER = /send|email|sms|text|reply|draft/i;

export function isBackgroundActor(requestedBy: string | null | undefined): boolean {
  return !!requestedBy && (requestedBy.startsWith("system:") || requestedBy.startsWith("routine:"));
}

/** Background cards expire in 30–60 minutes. A person who asked in chat waits the normal window. */
export function approvalExpiryMs(requestedBy: string, minutes = 45, personTtlMs = 24 * 60 * 60 * 1000): number {
  if (!isBackgroundActor(requestedBy)) return personTtlMs;
  const clamped = Math.min(60, Math.max(30, Math.round(minutes)));
  return clamped * 60 * 1000;
}

export function approvalCard(input: {
  summary: string;
  tier: number;
  toolName: string;
  requestedBy?: string | null;
  who?: string;
  when?: string;
}): ApprovalCardView {
  const badges: WarningBadge[] = [];
  if (input.tier >= 4) badges.push("can't be undone");
  if (input.tier === 3 || MONEY.test(input.toolName) || MONEY.test(input.summary)) badges.push("money");
  if (input.tier === 2 || CUSTOMER.test(input.toolName)) badges.push("goes to a customer");
  const excluded = input.tier >= 2 || badges.includes("money") || badges.includes("can't be undone");
  const background = isBackgroundActor(input.requestedBy);
  return {
    line: input.summary.trim() || "Scout wants to take an action",
    facts: [
      { label: "What", value: input.toolName },
      { label: "Who", value: input.who || "your business" },
      ...(input.when ? [{ label: "When", value: input.when }] : []),
    ],
    badges,
    alwaysAllowBlocked: excluded
      ? "This can't become an automatic rule. It spends money, goes to a customer, or can't be undone. Approve once if you want this one."
      : null,
    suggestedRule: excluded ? null : `Always ${input.summary.trim().slice(0, 160)}`,
    background,
    expiresInMinutes: background ? 45 : null,
  };
}

/** Deny means the action stops. Callers must not enqueue the same action again. */
export function denyStopsRetry(): true {
  return true;
}
