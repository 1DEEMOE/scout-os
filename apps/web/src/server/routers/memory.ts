import { z } from "zod";
import { forgetMemory, listOrgMemory, rememberFact } from "@wos/core";
import { protectedProcedure, router } from "../trpc";

const orgId = z.string().max(64);

export const memoryRouter = router({
  list: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listOrgMemory({ actorUserId: ctx.userId, ...input })),
  add: protectedProcedure.input(z.object({ orgId, content: z.string().max(5000) })).mutation(({ ctx, input }) => rememberFact({ actorUserId: ctx.userId, ...input })),
  forget: protectedProcedure.input(z.object({ orgId, memoryId: z.string().max(64) })).mutation(({ ctx, input }) => forgetMemory({ actorUserId: ctx.userId, ...input })),
});
