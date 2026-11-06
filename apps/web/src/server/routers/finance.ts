import { z } from "zod";
import {
  chaseOverdue,
  connectStripe,
  findOverdue,
  listFlaggedPaymentChanges,
  listInvoices,
  recordPaymentCallback,
  syncInvoices,
} from "@wos/core";
import { protectedProcedure, router } from "../trpc";

const orgId = z.string().max(64);
const id = z.string().max(64);

export const financeRouter = router({
  connectStripe: protectedProcedure
    .input(z.object({ orgId, secretKey: z.string().max(300) }))
    .mutation(({ ctx, input }) => connectStripe({ actorUserId: ctx.userId, ...input })),
  sync: protectedProcedure.input(z.object({ orgId })).mutation(({ ctx, input }) => syncInvoices({ actorUserId: ctx.userId, ...input })),
  invoices: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listInvoices({ actorUserId: ctx.userId, ...input })),
  overdue: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => findOverdue({ actorUserId: ctx.userId, ...input })),
  chaseOverdue: protectedProcedure.input(z.object({ orgId })).mutation(({ ctx, input }) => chaseOverdue({ actorUserId: ctx.userId, ...input })),
  flaggedPaymentChanges: protectedProcedure
    .input(z.object({ orgId }))
    .query(({ ctx, input }) => listFlaggedPaymentChanges({ actorUserId: ctx.userId, ...input })),
  recordPaymentCallback: protectedProcedure
    .input(z.object({ orgId, changeId: id, calledNumber: z.string().max(40), notes: z.string().max(1000).optional() }))
    .mutation(({ ctx, input }) => recordPaymentCallback({ actorUserId: ctx.userId, ...input })),
});
