import { z } from "zod";
import {
  chooseIndustry,
  clearDemoData,
  finishOnboarding,
  getOnboardingState,
  importLeadCsv,
  inviteDuringOnboarding,
  loadDemoData,
  markConnectLater,
  previewLeadCsv,
  saveBasics,
  skipDataStep,
  skipInvite,
} from "@wos/core";
import { protectedProcedure, router } from "../trpc";

const orgId = z.string().max(64);
const leadField = z.enum([
  "fullName", "email", "phone", "addressLine1", "city", "state", "postalCode", "county", "notes", "ignore",
]);

export const onboardingRouter = router({
  state: protectedProcedure
    .input(z.object({ orgId }))
    .query(({ ctx, input }) => getOnboardingState({ actorUserId: ctx.userId, orgId: input.orgId })),

  chooseIndustry: protectedProcedure
    .input(z.object({ orgId, industry: z.enum(["roofing", "general"]) }))
    .mutation(({ ctx, input }) => chooseIndustry({ actorUserId: ctx.userId, ...input })),

  saveBasics: protectedProcedure
    .input(z.object({
      orgId,
      name: z.string().max(200),
      timezone: z.string().max(64),
      zip: z.string().max(16).optional(),
      county: z.string().max(100).optional(),
      state: z.string().max(2).optional(),
    }))
    .mutation(({ ctx, input }) => saveBasics({ actorUserId: ctx.userId, ...input })),

  loadDemo: protectedProcedure
    .input(z.object({ orgId }))
    .mutation(({ ctx, input }) => loadDemoData({ actorUserId: ctx.userId, orgId: input.orgId })),

  clearDemo: protectedProcedure
    .input(z.object({ orgId }))
    .mutation(({ ctx, input }) => clearDemoData({ actorUserId: ctx.userId, orgId: input.orgId })),

  previewCsv: protectedProcedure
    .input(z.object({ orgId, csv: z.string().max(2_000_000) }))
    .mutation(async ({ ctx, input }) => {
      await getOnboardingState({ actorUserId: ctx.userId, orgId: input.orgId });
      return previewLeadCsv(input.csv);
    }),

  importCsv: protectedProcedure
    .input(z.object({
      orgId,
      csv: z.string().max(2_000_000),
      mapping: z.record(z.string(), leadField),
      label: z.string().max(120).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Ensure caller is in the org before parsing CSV.
      await getOnboardingState({ actorUserId: ctx.userId, orgId: input.orgId });
      return importLeadCsv({ actorUserId: ctx.userId, orgId: input.orgId, csv: input.csv, mapping: input.mapping, label: input.label });
    }),

  skipData: protectedProcedure
    .input(z.object({ orgId }))
    .mutation(({ ctx, input }) => skipDataStep({ actorUserId: ctx.userId, orgId: input.orgId })),

  connectLater: protectedProcedure
    .input(z.object({ orgId, skipped: z.array(z.string().max(40)).max(10) }))
    .mutation(({ ctx, input }) => markConnectLater({ actorUserId: ctx.userId, ...input })),

  invite: protectedProcedure
    .input(z.object({ orgId, email: z.string().max(320), role: z.string().max(20) }))
    .mutation(({ ctx, input }) => inviteDuringOnboarding({ actorUserId: ctx.userId, ...input })),

  skipInvite: protectedProcedure
    .input(z.object({ orgId }))
    .mutation(({ ctx, input }) => skipInvite({ actorUserId: ctx.userId, orgId: input.orgId })),

  finish: protectedProcedure
    .input(z.object({ orgId }))
    .mutation(({ ctx, input }) => finishOnboarding({ actorUserId: ctx.userId, orgId: input.orgId })),
});
