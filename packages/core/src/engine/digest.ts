import { createHash } from "node:crypto";

/** JSON with object keys sorted at every level, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export interface ActionIdentity {
  tenantId: string;
  taskId: string;
  agentId: string;
  step: number;
  tool: string;
  args: unknown;
  /** Lead bot delegation chain, when the task was delegated. Part of what a human approves. */
  chainId?: string;
}

/** The exact action a human approves. Any change to it produces a different digest. */
export function actionDigest(a: ActionIdentity): string {
  return createHash("sha256").update(canonicalJson(a.chainId ? a : { tenantId: a.tenantId, taskId: a.taskId, agentId: a.agentId, step: a.step, tool: a.tool, args: a.args })).digest("hex");
}
