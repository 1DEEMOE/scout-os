import { z } from "zod";
import {
  addFrontDeskSlots,
  addJobNote,
  analyzeIncomingDocument,
  enableFrontDesk,
  listFlaggedDocuments,
  listPendingFrontDeskBookings,
  listFrontDeskChannels,
  listFrontDeskSlots,
  rotateFrontDeskLink,
  setFrontDeskStatus,
  latestAiAnswersCheck,
  listAiAnswersTrend,
  runAiAnswersCheck,
  uploadJobPhoto,
  verifyJobPhotoChain,
  exportClaimPacket,
} from "@wos/core";
import { protectedProcedure, router } from "../trpc";

const orgId = z.string().max(64);
const id = z.string().max(64);

export const gaps2Router = router({
  frontDeskEnable: protectedProcedure
    .input(z.object({ orgId, displayName: z.string().min(1).max(120), timezone: z.string().max(64).optional() }))
    .mutation(({ ctx, input }) => enableFrontDesk({ actorUserId: ctx.userId, ...input })),
  frontDeskAddSlots: protectedProcedure
    .input(
      z.object({
        orgId,
        channelId: id,
        slots: z
          .array(
            z.object({
              startsAt: z.string().datetime(),
              endsAt: z.string().datetime(),
              capacity: z.number().int().min(1).max(50).optional(),
            }),
          )
          .max(50),
      }),
    )
    .mutation(({ ctx, input }) =>
      addFrontDeskSlots({
        actorUserId: ctx.userId,
        orgId: input.orgId,
        channelId: input.channelId,
        slots: input.slots.map((s) => ({
          startsAt: new Date(s.startsAt),
          endsAt: new Date(s.endsAt),
          capacity: s.capacity,
        })),
      }),
    ),
  frontDeskPending: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listPendingFrontDeskBookings({ actorUserId: ctx.userId, ...input })),
  frontDeskChannels: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listFrontDeskChannels({ actorUserId: ctx.userId, ...input })),
  frontDeskSlots: protectedProcedure.input(z.object({ orgId, channelId: id })).query(({ ctx, input }) => listFrontDeskSlots({ actorUserId: ctx.userId, ...input })),
  frontDeskSetStatus: protectedProcedure
    .input(z.object({ orgId, channelId: id, paused: z.boolean() }))
    .mutation(({ ctx, input }) =>
      setFrontDeskStatus({ actorUserId: ctx.userId, orgId: input.orgId, channelId: input.channelId, status: input.paused ? "paused" : "active" }),
    ),
  frontDeskRotateLink: protectedProcedure.input(z.object({ orgId, channelId: id })).mutation(({ ctx, input }) => rotateFrontDeskLink({ actorUserId: ctx.userId, ...input })),

  aiAnswersRun: protectedProcedure
    .input(z.object({ orgId, trade: z.string().max(80).optional(), zip: z.string().max(10), force: z.boolean().optional() }))
    .mutation(({ ctx, input }) => runAiAnswersCheck({ actorUserId: ctx.userId, ...input })),
  aiAnswersLatest: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => latestAiAnswersCheck({ actorUserId: ctx.userId, ...input })),
  aiAnswersTrend: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listAiAnswersTrend({ actorUserId: ctx.userId, ...input })),

  jobPhotoUpload: protectedProcedure
    .input(
      z.object({
        orgId,
        jobId: id,
        filename: z.string().min(1).max(200),
        contentType: z.string().min(3).max(100),
        /** Base64 of image bytes (no data: prefix). */
        bytesBase64: z.string().min(1).max(28_000_000),
        captureAt: z.string().datetime(),
        gpsLat: z.number().min(-90).max(90).optional(),
        gpsLng: z.number().min(-180).max(180).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      uploadJobPhoto({
        actorUserId: ctx.userId,
        orgId: input.orgId,
        jobId: input.jobId,
        filename: input.filename,
        contentType: input.contentType,
        bytes: Buffer.from(input.bytesBase64, "base64"),
        captureAt: new Date(input.captureAt),
        gpsLat: input.gpsLat,
        gpsLng: input.gpsLng,
      }),
    ),
  jobNoteAdd: protectedProcedure
    .input(z.object({ orgId, jobId: id, text: z.string().max(6000), observedAt: z.string().datetime().optional() }))
    .mutation(({ ctx, input }) =>
      addJobNote({ actorUserId: ctx.userId, orgId: input.orgId, jobId: input.jobId, text: input.text, ...(input.observedAt ? { observedAt: new Date(input.observedAt) } : {}) }),
    ),
  jobPhotoVerify: protectedProcedure
    .input(z.object({ orgId, jobId: id }))
    .query(({ ctx, input }) => verifyJobPhotoChain({ actorUserId: ctx.userId, ...input })),
  jobPhotoClaimPacket: protectedProcedure
    .input(z.object({ orgId, jobId: id }))
    .query(({ ctx, input }) => exportClaimPacket({ actorUserId: ctx.userId, ...input })),

  documentAnalyze: protectedProcedure
    .input(
      z.object({
        orgId,
        documentKind: z.enum(["invoice", "estimate"]),
        vendorName: z.string().min(1).max(200),
        vendorEmail: z.string().max(200).optional(),
        documentNumber: z.string().max(80).optional(),
        amountCents: z.number().int().min(0),
        currency: z.string().max(8).optional(),
        senderDomain: z.string().max(200).optional(),
        expectedDomain: z.string().max(200).optional(),
        accountLast4: z.string().regex(/^\d{4}$/).optional(),
        destinationId: id.optional(),
        pdfMetadata: z
          .object({
            producer: z.string().optional(),
            creator: z.string().optional(),
            modDate: z.string().optional(),
            createDate: z.string().optional(),
            suspicious: z.boolean().optional(),
          })
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => analyzeIncomingDocument({ actorUserId: ctx.userId, orgId: input.orgId, kind: input.documentKind, vendorName: input.vendorName, vendorEmail: input.vendorEmail, documentNumber: input.documentNumber, amountCents: input.amountCents, currency: input.currency, senderDomain: input.senderDomain, expectedDomain: input.expectedDomain, accountLast4: input.accountLast4, destinationId: input.destinationId, pdfMetadata: input.pdfMetadata })),
  documentsFlagged: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listFlaggedDocuments({ actorUserId: ctx.userId, ...input })),
});
