import { z } from "zod";
import {
  acceptInvitation,
  createOrg,
  inviteMember,
  listInvitations,
  listMembers,
  listMyOrgs,
  removeMember,
  revokeInvitation,
  setMemberRole,
} from "@wos/core";
import { protectedProcedure, router } from "../trpc";

// Shape checks only; the service owns business validation and authorization.
export const orgRouter = router({
  create: protectedProcedure
    .input(z.object({ name: z.string().max(500) }))
    .mutation(({ ctx, input }) => createOrg({ actorUserId: ctx.userId, name: input.name })),

  invite: protectedProcedure
    .input(z.object({ orgId: z.string().max(64), email: z.string().max(320), role: z.string().max(20) }))
    .mutation(({ ctx, input }) => inviteMember({ actorUserId: ctx.userId, ...input })),

  listMembers: protectedProcedure
    .input(z.object({ orgId: z.string().max(64) }))
    .query(({ ctx, input }) => listMembers({ actorUserId: ctx.userId, orgId: input.orgId })),

  listInvitations: protectedProcedure
    .input(z.object({ orgId: z.string().max(64) }))
    .query(({ ctx, input }) => listInvitations({ actorUserId: ctx.userId, orgId: input.orgId })),

  revokeInvitation: protectedProcedure
    .input(z.object({ orgId: z.string().max(64), invitationId: z.string().max(64) }))
    .mutation(({ ctx, input }) => revokeInvitation({ actorUserId: ctx.userId, ...input })),

  acceptInvitation: protectedProcedure
    .input(z.object({ orgId: z.string().max(64), token: z.string().max(200) }))
    .mutation(({ ctx, input }) => acceptInvitation({ actorUserId: ctx.userId, ...input })),

  removeMember: protectedProcedure
    .input(z.object({ orgId: z.string().max(64), userId: z.string().max(64) }))
    .mutation(({ ctx, input }) => removeMember({ actorUserId: ctx.userId, ...input })),

  setMemberRole: protectedProcedure
    .input(z.object({ orgId: z.string().max(64), userId: z.string().max(64), role: z.string().max(20) }))
    .mutation(({ ctx, input }) => setMemberRole({ actorUserId: ctx.userId, ...input })),

  listMine: protectedProcedure.query(({ ctx }) => listMyOrgs({ actorUserId: ctx.userId })),
});
