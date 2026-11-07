import { z } from "zod";
import {
  activityFeed,
  firstRunFor,
  handBack,
  memoryPanel,
  notifyPrefs,
  opportunitiesFor,
  pauseTask,
  readArtifactByToken,
  saveArtifact,
  saveChatRoutine,
  saveGoal,
  saveSuggestedRule,
  takeOverDraft,
  watchTask,
} from "@wos/core";
import { protectedProcedure, router } from "../trpc";

const orgId = z.string().max(64);

export const kimiRouter = router({
  firstRun: protectedProcedure.input(z.object({ orgId, businessName: z.string().max(120).optional(), packId: z.string().max(40).optional() })).query(({ ctx, input }) => firstRunFor({ actorUserId: ctx.userId, orgId: input.orgId, businessName: input.businessName || "Your business", packId: input.packId || "general" })),
  feed: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => activityFeed({ actorUserId: ctx.userId, orgId: input.orgId })),
  watch: protectedProcedure.input(z.object({ orgId, taskId: z.string().max(64).optional() })).query(({ ctx, input }) => watchTask({ actorUserId: ctx.userId, orgId: input.orgId, taskId: input.taskId || "00000000-0000-4000-8000-000000000000" })),
  pause: protectedProcedure.input(z.object({ orgId, taskId: z.string().max(64).optional() })).mutation(({ ctx, input }) => pauseTask({ actorUserId: ctx.userId, orgId: input.orgId, taskId: input.taskId || "00000000-0000-4000-8000-000000000000" })),
  takeOver: protectedProcedure.input(z.object({ orgId, taskId: z.string().max(64).optional(), text: z.string().max(1500).optional() })).mutation(({ ctx, input }) => takeOverDraft({ actorUserId: ctx.userId, orgId: input.orgId, taskId: input.taskId || "00000000-0000-4000-8000-000000000000", text: input.text || "Draft" })),
  handBack: protectedProcedure.input(z.object({ orgId, taskId: z.string().max(64).optional() })).mutation(({ ctx, input }) => handBack({ actorUserId: ctx.userId, orgId: input.orgId, taskId: input.taskId || "00000000-0000-4000-8000-000000000000" })),
  memory: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => memoryPanel({ actorUserId: ctx.userId, orgId: input.orgId })),
  saveRule: protectedProcedure.input(z.object({ orgId, text: z.string().max(300).optional(), tier: z.number().int().optional(), toolName: z.string().max(80).optional() })).mutation(({ ctx, input }) => saveSuggestedRule({ actorUserId: ctx.userId, orgId: input.orgId, text: input.text || "note", tier: input.tier ?? 1, toolName: input.toolName || "memory.note" })),
  routine: protectedProcedure.input(z.object({ orgId, text: z.string().max(500).optional() })).mutation(({ ctx, input }) => saveChatRoutine({ actorUserId: ctx.userId, orgId: input.orgId, text: input.text || "every Friday, list open jobs" })),
  opportunities: protectedProcedure.input(z.object({ orgId, packId: z.string().max(40).optional() })).query(({ ctx, input }) => opportunitiesFor({ actorUserId: ctx.userId, orgId: input.orgId, packId: input.packId || "general" })),
  notify: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => notifyPrefs({ actorUserId: ctx.userId, orgId: input.orgId })),
  goal: protectedProcedure.input(z.object({ orgId, text: z.string().max(200).optional() })).mutation(({ ctx, input }) => saveGoal({ actorUserId: ctx.userId, orgId: input.orgId, text: input.text || "Fill Thursday afternoon" })),
  artifact: protectedProcedure.input(z.object({ orgId, title: z.string().max(120).optional() })).mutation(({ ctx, input }) => saveArtifact({ actorUserId: ctx.userId, orgId: input.orgId, title: input.title || "Weekly note" })),
  artifactRead: protectedProcedure.input(z.object({ orgId, token: z.string().max(80).optional() })).query(({ ctx, input }) => readArtifactByToken({ actorUserId: ctx.userId, orgId: input.orgId, token: input.token || "missing" })),
});
