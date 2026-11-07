import { ToolError, type AnyTool, type ToolContext } from "./tools";

const hits = new Map<string, number[]>();

export function resetToolRates(): void {
  hits.clear();
}

/** Sliding window. Returns false when the tool is over its limit for this tenant. */
export function takeToolRate(tenantId: string, tool: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const key = `${tenantId}:${tool}`;
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

export function beforeToolCall(tool: AnyTool, ctx: ToolContext, now = Date.now()): void {
  if (!tool.rate) return;
  if (!takeToolRate(ctx.tenantId, tool.name, tool.rate.limit, tool.rate.windowMs, now)) {
    throw new ToolError(`Too many ${tool.name} calls in a short window`, false, "RATE_LIMITED");
  }
}

export function checkToolOutput(tool: AnyTool, output: unknown): unknown {
  if (!tool.output) return output;
  const parsed = tool.output.safeParse(output);
  if (!parsed.success) throw new ToolError("Tool returned a value outside its contract", false, "BAD_OUTPUT");
  return parsed.data;
}
