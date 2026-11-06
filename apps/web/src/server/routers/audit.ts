import { z } from "zod";
import { listAuditEvents, verifyAuditChain } from "@wos/core";
import { protectedProcedure, router } from "../trpc";

export const auditRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        orgId: z.string().max(64),
        actionPrefix: z.string().max(100).optional(),
        actorType: z.enum(["user", "agent", "system"]).optional(),
        outcome: z.enum(["success", "denied", "error"]).optional(),
        beforeSeq: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(({ ctx, input }) => listAuditEvents({ actorUserId: ctx.userId, ...input })),

  verifyChain: protectedProcedure
    .input(z.object({ orgId: z.string().max(64) }))
    .query(({ ctx, input }) => verifyAuditChain({ actorUserId: ctx.userId, orgId: input.orgId })),
});
