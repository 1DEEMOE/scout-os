import { z } from "zod";
import {
  addContactNote,
  connectHubSpot,
  contact360,
  createDeal,
  getContact,
  getDeal,
  getLeadFormSettings,
  listContacts,
  listContactsEnriched,
  listDeals,
  listPipeline,
  moveDeal,
  NATIVE_DEAL_STAGES,
  OPEN_STAGES,
  pipelineForecast,
  qualifyLead,
  saveLeadFormSettings,
  savePipelineConfig,
  updateDeal,
} from "@wos/core";
import { protectedProcedure, router } from "../trpc";

const orgId = z.string().max(64);
const dealStage = z.enum(NATIVE_DEAL_STAGES);
const expectedClose = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected close must be YYYY-MM-DD");

export const crmRouter = router({
  connectHubSpot: protectedProcedure
    .input(z.object({ orgId, accessToken: z.string().max(500), label: z.string().max(120) }))
    .mutation(({ ctx, input }) => connectHubSpot({ actorUserId: ctx.userId, ...input })),
  contacts: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listContacts({ actorUserId: ctx.userId, ...input })),
  deals: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listDeals({ actorUserId: ctx.userId, ...input })),
  qualifyLead: protectedProcedure
    .input(z.object({ orgId, conversationId: z.string().max(64) }))
    .mutation(({ ctx, input }) => qualifyLead({ actorUserId: ctx.userId, ...input })),

  /* ---------------------------------------------------- native pipeline */
  pipeline: protectedProcedure
    .input(z.object({ orgId, dealStage: dealStage.optional() }))
    .query(({ ctx, input }) => listPipeline({ actorUserId: ctx.userId, orgId: input.orgId, stage: input.dealStage })),
  deal: protectedProcedure
    .input(z.object({ orgId, dealId: z.string().max(64) }))
    .query(({ ctx, input }) => getDeal({ actorUserId: ctx.userId, ...input })),
  forecast: protectedProcedure
    .input(z.object({ orgId, month: z.string().regex(/^\d{4}-\d{2}$/).optional() }))
    .query(({ ctx, input }) => pipelineForecast({ actorUserId: ctx.userId, ...input })),
  createDeal: protectedProcedure
    .input(
      z.object({
        orgId,
        contactId: z.string().max(64).nullish(),
        name: z.string().min(1).max(120),
        amountCents: z.number().int().min(0).max(10_000_000_000).nullish(),
        dealStage: z.enum(OPEN_STAGES).optional(),
        expectedClose: expectedClose.nullish(),
        ownerUserId: z.string().max(64).nullish(),
      }),
    )
    .mutation(({ ctx, input }) =>
      createDeal({
        actorUserId: ctx.userId,
        orgId: input.orgId,
        contactId: input.contactId,
        name: input.name,
        amountCents: input.amountCents,
        stage: input.dealStage,
        expectedClose: input.expectedClose,
        ownerUserId: input.ownerUserId,
      }),
    ),
  updateDeal: protectedProcedure
    .input(
      z.object({
        orgId,
        dealId: z.string().max(64),
        name: z.string().min(1).max(120).optional(),
        amountCents: z.number().int().min(0).max(10_000_000_000).nullish(),
        expectedClose: expectedClose.nullish(),
        ownerUserId: z.string().max(64).nullish(),
        contactId: z.string().max(64).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => updateDeal({ actorUserId: ctx.userId, ...input })),
  moveDeal: protectedProcedure
    .input(z.object({ orgId, dealId: z.string().max(64), dealStage, lostReason: z.string().max(200).nullish() }))
    .mutation(({ ctx, input }) =>
      moveDeal({ actorUserId: ctx.userId, orgId: input.orgId, dealId: input.dealId, stage: input.dealStage, lostReason: input.lostReason }),
    ),
  savePipelineConfig: protectedProcedure
    // zod v4: z.record(z.enum(...), v) is EXHAUSTIVE (every enum key required).
    // partialRecord is the optional-key variant this form needs.
    .input(z.object({ orgId, probabilities: z.partialRecord(z.enum(OPEN_STAGES), z.number().int().min(0).max(10_000)) }))
    .mutation(({ ctx, input }) => savePipelineConfig({ actorUserId: ctx.userId, orgId: input.orgId, probabilityBps: input.probabilities })),

  /* ------------------------------------------------------- contact 360 */
  contactsEnriched: protectedProcedure
    .input(z.object({ orgId }))
    .query(({ ctx, input }) => listContactsEnriched({ actorUserId: ctx.userId, ...input })),
  contact: protectedProcedure
    .input(z.object({ orgId, contactId: z.string().max(64) }))
    .query(({ ctx, input }) => getContact({ actorUserId: ctx.userId, ...input })),
  contact360: protectedProcedure
    .input(z.object({ orgId, contactId: z.string().max(64) }))
    .query(({ ctx, input }) => contact360({ actorUserId: ctx.userId, ...input })),
  addNote: protectedProcedure
    .input(z.object({ orgId, contactId: z.string().max(64), content: z.string().min(1).max(2000) }))
    .mutation(({ ctx, input }) => addContactNote({ actorUserId: ctx.userId, orgId: input.orgId, contactId: input.contactId, body: input.content })),

  /* --------------------------------------------------------- lead form */
  leadFormSettings: protectedProcedure
    .input(z.object({ orgId }))
    .query(({ ctx, input }) => getLeadFormSettings({ actorUserId: ctx.userId, ...input })),
  saveLeadForm: protectedProcedure
    .input(
      z.object({
        orgId,
        channelId: z.string().max(64),
        form: z
          .object({
            enabled: z.boolean(),
            intro: z.string().max(300),
            successMessage: z.string().max(300),
            askPhone: z.boolean(),
            askCompany: z.boolean(),
            askMessage: z.boolean(),
          })
          .partial(),
      }),
    )
    .mutation(({ ctx, input }) => saveLeadFormSettings({ actorUserId: ctx.userId, ...input })),
});
