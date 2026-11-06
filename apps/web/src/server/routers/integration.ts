import { z } from "zod";
import { disconnectIntegration, listIntegrations } from "@wos/core";
import { protectedProcedure, router } from "../trpc";

export const integrationRouter = router({
  list: protectedProcedure
    .input(z.object({ orgId: z.string().max(64) }))
    .query(({ ctx, input }) => listIntegrations({ actorUserId: ctx.userId, orgId: input.orgId })),

  disconnect: protectedProcedure
    .input(z.object({ orgId: z.string().max(64), connectionId: z.string().max(64) }))
    .mutation(({ ctx, input }) => disconnectIntegration({ actorUserId: ctx.userId, ...input })),
});
