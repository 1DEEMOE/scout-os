import { z } from "zod";
import { withTenant } from "@wos/db";
import { requireFeature } from "../billing/plans";
import { ToolError, type ToolDefinition, type ToolRegistry } from "../engine/tools";
import { AppError } from "../errors";
import { runScoutScan } from "./service";

/**
 * Scout's only tool. Deterministic code, tier 1 (internal writes). The plan
 * is checked again here, at execution time, so a downgrade also stops work
 * that was already queued.
 */
export function scoutTools(): ToolDefinition[] {
  const scan: ToolDefinition<Record<string, never>> = {
    name: "scout.scan",
    description: "Match your prospects against recent storm reports in your reviewed service area and score them. Internal only; contacts nobody.",
    tier: 1,
    args: z.object({}).strict(),
    summarize: () => "Scan prospects against recent storm reports",
    async execute(ctx) {
      try {
        return await withTenant(ctx.tenantId, async (tx) => {
          await requireFeature(tx, ctx.tenantId, "scout", { type: "agent", id: ctx.agentId }, "scout.scan");
          return runScoutScan(tx, ctx.tenantId, { type: "agent", id: ctx.agentId });
        });
      } catch (e) {
        if (e instanceof AppError) throw new ToolError(e.message, false, e.code);
        throw e;
      }
    },
  };
  return [scan] as ToolDefinition[];
}

export function registerScoutTools(registry: ToolRegistry): void {
  registry.register(...scoutTools());
}
