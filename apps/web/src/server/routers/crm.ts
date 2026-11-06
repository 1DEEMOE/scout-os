import { z } from "zod";
import { connectHubSpot, listContacts, listDeals, qualifyLead } from "@wos/core";
import { protectedProcedure, router } from "../trpc";

const orgId = z.string().max(64);

export const crmRouter = router({
  connectHubSpot: protectedProcedure
    .input(z.object({ orgId, accessToken: z.string().max(500), label: z.string().max(120) }))
    .mutation(({ ctx, input }) => connectHubSpot({ actorUserId: ctx.userId, ...input })),
  contacts: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listContacts({ actorUserId: ctx.userId, ...input })),
  deals: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listDeals({ actorUserId: ctx.userId, ...input })),
  qualifyLead: protectedProcedure
    .input(z.object({ orgId, conversationId: z.string().max(64) }))
    .mutation(({ ctx, input }) => qualifyLead({ actorUserId: ctx.userId, ...input })),
});
