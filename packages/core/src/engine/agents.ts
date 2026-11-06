import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { AGENT_KINDS, agentPermissions, agents, agentVersions, isUuid, type AgentKind, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { ANY_ROLE, inOrg, MANAGERS, requireRole } from "../org/access";
import type { AgentGrant } from "./policy";
import { getEngine } from "./runtime";

const specSchema = z.object({
  kind: z.enum(AGENT_KINDS),
  displayName: z.string().trim().min(1).max(80),
  instructions: z.string().trim().min(1).max(8000),
  tools: z.array(z.object({ name: z.string().min(1), maxTier: z.number().int().min(0).max(4) })).max(50),
  modelPolicy: z.object({ provider: z.string().optional(), model: z.string().optional(), maxTokens: z.number().int().positive().max(8192).optional() }).default({}),
});
export type AgentSpec = z.input<typeof specSchema>;

/** Creates an agent with version 1 and its tool permissions. Owners and admins only. */
export async function createAgent(input: { actorUserId: string; orgId: string; spec: AgentSpec }): Promise<{ agentId: string }> {
  const r = specSchema.safeParse(input.spec);
  if (!r.success) throw new AppError("VALIDATION", r.error.issues[0]?.message ?? "Invalid agent");
  const spec = r.data;
  const registry = getEngine().tools;
  for (const t of spec.tools) {
    if (!registry.get(t.name)) throw new AppError("VALIDATION", `Unknown tool ${t.name}`);
  }
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "agent.create");
    const existing = await tx.select({ id: agents.id }).from(agents).where(eq(agents.kind, spec.kind));
    if (existing.length) throw new AppError("CONFLICT", `This organization already has a ${spec.kind} agent`);
    const [agent] = await tx.insert(agents).values({ tenantId: input.orgId, kind: spec.kind, displayName: spec.displayName }).returning();
    const [version] = await tx
      .insert(agentVersions)
      .values({
        tenantId: input.orgId,
        agentId: agent!.id,
        version: 1,
        instructions: spec.instructions,
        toolAllowlist: spec.tools.map((t) => t.name),
        modelPolicy: spec.modelPolicy,
        createdBy: input.actorUserId,
      })
      .returning();
    await tx.update(agents).set({ currentVersionId: version!.id }).where(eq(agents.id, agent!.id));
    if (spec.tools.length) {
      await tx.insert(agentPermissions).values(
        spec.tools.map((t) => ({ tenantId: input.orgId, agentId: agent!.id, toolName: t.name, maxTier: t.maxTier })),
      );
    }
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "agent.create",
      target: `agent:${agent!.id}`,
      tier: 4,
      outcome: "success",
      metadata: { kind: spec.kind, tools: spec.tools },
    });
    return { agentId: agent!.id };
  });
}

export async function listAgents(input: { actorUserId: string; orgId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "agent.list");
    const rows = await tx.select().from(agents).orderBy(agents.kind);
    const perms = rows.length ? await tx.select().from(agentPermissions).where(inArray(agentPermissions.agentId, rows.map((a) => a.id))) : [];
    return rows.map((a) => ({ ...a, permissions: perms.filter((p) => p.agentId === a.id).map((p) => ({ tool: p.toolName, maxTier: p.maxTier })) }));
  });
}

export interface LoadedAgent {
  agent: typeof agents.$inferSelect;
  version: typeof agentVersions.$inferSelect;
  grant: AgentGrant;
}

export async function loadAgent(tx: Tx, where: { id: string } | { kind: AgentKind }): Promise<LoadedAgent | null> {
  if ("id" in where && !isUuid(where.id)) return null;
  const [agent] = await tx
    .select()
    .from(agents)
    .where("id" in where ? eq(agents.id, where.id) : and(eq(agents.kind, where.kind), eq(agents.status, "active")));
  if (!agent?.currentVersionId) return null;
  const [version] = await tx.select().from(agentVersions).where(eq(agentVersions.id, agent.currentVersionId));
  const perms = await tx.select().from(agentPermissions).where(eq(agentPermissions.agentId, agent.id));
  return {
    agent,
    version: version!,
    grant: { allowlist: version!.toolAllowlist, maxTier: new Map(perms.map((p) => [p.toolName, p.maxTier])) },
  };
}
