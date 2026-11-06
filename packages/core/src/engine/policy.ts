import type { AnyTool, Tier } from "./tools";

export type PolicyDecision =
  | { kind: "allow" }
  | { kind: "needs_approval"; tier: Tier; confirmations: 1 | 2 }
  | { kind: "deny"; reason: string };

export interface AgentGrant {
  allowlist: readonly string[];
  /** tool name -> highest tier this agent may use it at */
  maxTier: ReadonlyMap<string, number>;
}

/**
 * The approval policy from CLAUDE.md, enforced in code. Model output never
 * reaches this function except as the tool name and arguments it proposed.
 *
 * Tier 0-1: run.  Tier 2-3: one human approval.  Tier 4: approval plus a
 * second confirmation. There is no setting that lets tier 2+ skip a human.
 */
export function evaluatePolicy(tool: AnyTool | undefined, toolName: string, grant: AgentGrant): PolicyDecision {
  if (!tool) return { kind: "deny", reason: `Unknown tool "${toolName}"` };
  if (!grant.allowlist.includes(tool.name)) return { kind: "deny", reason: `Agent is not allowed to use ${tool.name}` };
  const max = grant.maxTier.get(tool.name);
  if (max === undefined) return { kind: "deny", reason: `Agent has no permission row for ${tool.name}` };
  if (tool.tier > max) return { kind: "deny", reason: `${tool.name} is tier ${tool.tier}; agent limit is ${max}` };
  if (tool.tier <= 1) return { kind: "allow" };
  return { kind: "needs_approval", tier: tool.tier, confirmations: tool.tier === 4 ? 2 : 1 };
}

// ---------- Milestone 12: delegation and provenance ----------

/** Highest tier the lead bot may ever delegate. Tier 4 (destructive/privileged) is never delegated. */
export const LEAD_BOT_MAX_TIER = 3;

/** Highest tier a person in each role may have an agent act at on their behalf. */
export const ROLE_TIER_CEILING: Record<string, number> = { owner: 4, admin: 4, member: 2, viewer: 0 };

/**
 * Effective grant of a delegated sub-agent: its own grant, capped by the lead
 * bot's ceiling and by the requesting user's role. Never broader than any of them.
 */
export function intersectGrant(grant: AgentGrant, ceiling: number): AgentGrant {
  return {
    allowlist: grant.allowlist,
    maxTier: new Map([...grant.maxTier].map(([tool, max]) => [tool, Math.min(max, ceiling)])),
  };
}

const ADDRESS_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|https?:\/\/[^\s"'<>]+/gi;

/**
 * Provenance check: paths of argument strings that carry an email address or
 * URL also present in externally sourced text (emails, task input, chat
 * context). Such values could have been planted by a third party, so the
 * step is forced to tier 2+ (human approval) whatever its tool tier.
 */
export function taintedArgs(args: unknown, externalText: string): string[] {
  if (!externalText) return [];
  const external = new Set((externalText.match(ADDRESS_RE) ?? []).map((s) => s.toLowerCase()));
  if (!external.size) return [];
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      if ((v.match(ADDRESS_RE) ?? []).some((m) => external.has(m.toLowerCase()))) out.push(path || "$");
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(args, "");
  return out;
}
