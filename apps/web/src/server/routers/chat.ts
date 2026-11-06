import { z } from "zod";
import { createThread, getThread, listThreads, sendMessage } from "@wos/core";
import { protectedProcedure, router } from "../trpc";

const orgId = z.string().max(64);
const threadId = z.string().max(64);

export const chatRouter = router({
  createThread: protectedProcedure
    .input(z.object({ orgId, title: z.string().max(200) }))
    .mutation(({ ctx, input }) => createThread({ actorUserId: ctx.userId, ...input })),
  listThreads: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listThreads({ actorUserId: ctx.userId, ...input })),
  getThread: protectedProcedure.input(z.object({ orgId, threadId })).query(({ ctx, input }) => getThread({ actorUserId: ctx.userId, ...input })),
  send: protectedProcedure
    .input(z.object({ orgId, threadId, content: z.string().max(4000), clientRef: z.string().max(100).optional() }))
    .mutation(({ ctx, input }) => sendMessage({ actorUserId: ctx.userId, ...input })),
});
