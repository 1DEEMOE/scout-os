import { z } from "zod";
import { AGENT_KINDS, APPROVAL_STATUSES } from "@wos/db";
import { cancelTask, confirmApproval, createAgent, createTask, decideApproval, getPauseState, getTask, listAgents, listApprovals, listTasks, provisionRecommendedAgents, retryEscalatedTask, setAgentsPaused } from "@wos/core";
import { protectedProcedure, router } from "../trpc";

const orgId = z.string().max(64);
const id = z.string().max(64);

export const agentRouter = router({
  list: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listAgents({ actorUserId: ctx.userId, orgId: input.orgId })),
  create: protectedProcedure
    .input(
      z.object({
        orgId,
        spec: z.object({
          kind: z.enum(AGENT_KINDS),
          displayName: z.string().max(200),
          instructions: z.string().max(10000),
          tools: z.array(z.object({ name: z.string().max(100), maxTier: z.number().int() })).max(50),
        }),
      }),
    )
    .mutation(({ ctx, input }) => createAgent({ actorUserId: ctx.userId, orgId: input.orgId, spec: input.spec })),
  pauseState: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => getPauseState({ actorUserId: ctx.userId, ...input })),
  setPaused: protectedProcedure
    .input(z.object({ orgId, paused: z.boolean() }))
    .mutation(({ ctx, input }) => setAgentsPaused({ actorUserId: ctx.userId, ...input })),
  provisionRecommended: protectedProcedure
    .input(z.object({ orgId }))
    .mutation(({ ctx, input }) => provisionRecommendedAgents({ actorUserId: ctx.userId, ...input })),
});

export const taskRouter = router({
  create: protectedProcedure
    .input(z.object({ orgId, intent: z.string().max(5000), input: z.record(z.string(), z.unknown()).optional() }))
    .mutation(({ ctx, input }) => createTask({ actorUserId: ctx.userId, ...input })),
  list: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listTasks({ actorUserId: ctx.userId, orgId: input.orgId })),
  get: protectedProcedure.input(z.object({ orgId, taskId: id })).query(({ ctx, input }) => getTask({ actorUserId: ctx.userId, ...input })),
  retry: protectedProcedure.input(z.object({ orgId, taskId: id })).mutation(({ ctx, input }) => retryEscalatedTask({ actorUserId: ctx.userId, ...input })),
  cancel: protectedProcedure.input(z.object({ orgId, taskId: id })).mutation(({ ctx, input }) => cancelTask({ actorUserId: ctx.userId, ...input })),
});

export const approvalRouter = router({
  list: protectedProcedure
    .input(z.object({ orgId, status: z.enum(APPROVAL_STATUSES).optional() }))
    .query(({ ctx, input }) => listApprovals({ actorUserId: ctx.userId, ...input })),
  decide: protectedProcedure
    .input(z.object({ orgId, approvalId: id, decision: z.enum(["approve", "reject"]) }))
    .mutation(({ ctx, input }) => decideApproval({ actorUserId: ctx.userId, ...input })),
  confirm: protectedProcedure
    .input(z.object({ orgId, approvalId: id }))
    .mutation(({ ctx, input }) => confirmApproval({ actorUserId: ctx.userId, ...input })),
});
