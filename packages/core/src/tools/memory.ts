import { z } from "zod";
import { memoryRecords, withTenant } from "@wos/db";
import type { ToolDefinition, ToolRegistry } from "../engine/tools";

/**
 * memory.note: the agent's scratch notes, visible only within the same task.
 * memory.propose_fact: a business fact the agent wants kept; a person approves
 * it (tier 2) before it becomes org memory, which is how poisoning is stopped.
 */
export function memoryTools(): ToolDefinition[] {
  const note: ToolDefinition<{ content: string }> = {
    name: "memory.note",
    description: "Keep a short working note for the rest of this task only.",
    tier: 1,
    output: z.object({ saved: z.literal(true) }),
    args: z.object({ content: z.string().trim().min(1).max(1000) }),
    summarize: (a) => `Note for this task: ${a.content.slice(0, 80)}`,
    async execute(ctx, a) {
      await withTenant(ctx.tenantId, (tx) =>
        tx.insert(memoryRecords).values({ tenantId: ctx.tenantId, layer: "working", scopeRef: ctx.taskId, content: a.content, trust: "agent", createdByAgent: ctx.agentId, sourceRef: `task:${ctx.taskId}` }),
      );
      return { saved: true };
    },
  };

  const propose: ToolDefinition<{ content: string; reason: string }> = {
    name: "memory.propose_fact",
    description: "Ask a person to approve remembering a fact about the business for future tasks.",
    tier: 2,
    output: z.object({ remembered: z.literal(true) }),
    args: z.object({ content: z.string().trim().min(1).max(1000), reason: z.string().trim().min(1).max(300) }),
    summarize: (a) => `Remember for all future tasks: "${a.content.slice(0, 160)}"`,
    async execute(ctx, a) {
      await withTenant(ctx.tenantId, (tx) =>
        tx.insert(memoryRecords).values({ tenantId: ctx.tenantId, layer: "org", scopeRef: "org", content: a.content, trust: "verified", createdByAgent: ctx.agentId, sourceRef: `task:${ctx.taskId}` }),
      );
      return { remembered: true };
    },
  };

  return [note, propose] as ToolDefinition[];
}

export function registerMemoryTools(registry: ToolRegistry): void {
  registry.register(...memoryTools());
}
