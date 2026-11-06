import { z } from "zod";
import { getConversation, listConversations, listMailboxes, requestSendDraft, setMailboxMode, syncInbox, triageConversation } from "@wos/core";
import { protectedProcedure, router } from "../trpc";

const orgId = z.string().max(64);
const conversationId = z.string().max(64);

export const inboxRouter = router({
  mailboxes: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listMailboxes({ actorUserId: ctx.userId, ...input })),
  setMode: protectedProcedure
    .input(z.object({ orgId, identityId: z.string().max(64), mode: z.enum(["draft_only", "send_with_approval"]) }))
    .mutation(({ ctx, input }) => setMailboxMode({ actorUserId: ctx.userId, ...input })),
  sync: protectedProcedure.input(z.object({ orgId })).mutation(({ ctx, input }) => syncInbox({ actorUserId: ctx.userId, ...input })),
  list: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listConversations({ actorUserId: ctx.userId, ...input })),
  get: protectedProcedure.input(z.object({ orgId, conversationId })).query(({ ctx, input }) => getConversation({ actorUserId: ctx.userId, ...input })),
  triage: protectedProcedure.input(z.object({ orgId, conversationId })).mutation(({ ctx, input }) => triageConversation({ actorUserId: ctx.userId, ...input })),
  requestSend: protectedProcedure.input(z.object({ orgId, conversationId })).mutation(({ ctx, input }) => requestSendDraft({ actorUserId: ctx.userId, ...input })),
});
