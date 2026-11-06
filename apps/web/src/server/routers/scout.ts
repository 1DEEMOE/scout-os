import { z } from "zod";
import {
  addSuppression,
  disqualifyOpportunity,
  draftFirstOutreach,
  getBusinessProfile,
  getOpportunity,
  importProspects,
  listContactRules,
  listOpportunities,
  listSignals,
  listSources,
  markEngaged,
  qualifyOpportunity,
  recordPermission,
  requestHandoff,
  requestOutreachApproval,
  requestScan,
  reviewBusinessProfile,
  revokePermission,
  runOpportunityFinder,
  saveBusinessProfile,
  scoutAnalytics,
  uploadStormReports,
} from "@wos/core";
import { protectedProcedure, router } from "../trpc";

// Shapes only; the services authorize first, then validate content.
const orgId = z.string().max(64);
const id = z.string().max(64);
const text = (max: number) => z.string().max(max);
const MAX_CSV = 2_000_000;

export const scoutRouter = router({
  /** Opportunity finder: public signals (MOCK adapters today) → scored local jobs. Managers. */
  findOpportunities: protectedProcedure
    .input(z.object({ orgId }))
    .mutation(({ ctx, input }) => runOpportunityFinder({ actorUserId: ctx.userId, orgId: input.orgId })),
  draftOutreach: protectedProcedure
    .input(z.object({ orgId, opportunityId: id }))
    .query(({ ctx, input }) => draftFirstOutreach({ actorUserId: ctx.userId, ...input })),
  /** The exact message becomes a tier-2, owner-only approval. Nothing is sent here. */
  requestOutreach: protectedProcedure
    .input(z.object({ orgId, opportunityId: id, subject: text(300), body: text(6000) }))
    .mutation(({ ctx, input }) => requestOutreachApproval({ actorUserId: ctx.userId, ...input })),

  profile: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => getBusinessProfile({ actorUserId: ctx.userId, ...input })),
  saveProfile: protectedProcedure.input(z.object({ orgId, profile: z.unknown() })).mutation(({ ctx, input }) => saveBusinessProfile({ actorUserId: ctx.userId, ...input })),
  reviewProfile: protectedProcedure.input(z.object({ orgId })).mutation(({ ctx, input }) => reviewBusinessProfile({ actorUserId: ctx.userId, ...input })),
  uploadSignals: protectedProcedure
    .input(z.object({ orgId, csv: text(MAX_CSV + 1), filename: text(200).optional(), reportDay: text(10).optional() }))
    .mutation(({ ctx, input }) => uploadStormReports({ actorUserId: ctx.userId, ...input })),
  importProspects: protectedProcedure
    .input(z.object({ orgId, csv: text(MAX_CSV + 1), label: text(200), usageRights: text(2000), attest: z.boolean() }))
    .mutation(({ ctx, input }) => importProspects({ actorUserId: ctx.userId, ...input })),
  scan: protectedProcedure.input(z.object({ orgId })).mutation(({ ctx, input }) => requestScan({ actorUserId: ctx.userId, ...input })),
  opportunities: protectedProcedure.input(z.object({ orgId, stage: text(20).optional() })).query(({ ctx, input }) => listOpportunities({ actorUserId: ctx.userId, ...input })),
  opportunity: protectedProcedure.input(z.object({ orgId, opportunityId: id })).query(({ ctx, input }) => getOpportunity({ actorUserId: ctx.userId, ...input })),
  signals: protectedProcedure.input(z.object({ orgId, kind: text(20).optional(), state: text(2).optional() })).query(({ ctx, input }) => listSignals({ actorUserId: ctx.userId, ...input })),
  sources: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listSources({ actorUserId: ctx.userId, ...input })),
  engage: protectedProcedure.input(z.object({ orgId, opportunityId: id, evidence: text(2000) })).mutation(({ ctx, input }) => markEngaged({ actorUserId: ctx.userId, ...input })),
  qualify: protectedProcedure
    .input(z.object({ orgId, opportunityId: id, answers: z.record(z.string().max(40), z.union([z.string().max(500), z.boolean()])), note: text(1000).optional() }))
    .mutation(({ ctx, input }) => qualifyOpportunity({ actorUserId: ctx.userId, ...input })),
  disqualify: protectedProcedure.input(z.object({ orgId, opportunityId: id, reason: text(500) })).mutation(({ ctx, input }) => disqualifyOpportunity({ actorUserId: ctx.userId, ...input })),
  handoff: protectedProcedure.input(z.object({ orgId, opportunityId: id })).mutation(({ ctx, input }) => requestHandoff({ actorUserId: ctx.userId, ...input })),
  contactRules: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listContactRules({ actorUserId: ctx.userId, ...input })),
  recordPermission: protectedProcedure.input(z.object({ orgId, email: text(254), basis: text(40), evidence: text(2000) })).mutation(({ ctx, input }) => recordPermission({ actorUserId: ctx.userId, ...input })),
  revokePermission: protectedProcedure.input(z.object({ orgId, email: text(254) })).mutation(({ ctx, input }) => revokePermission({ actorUserId: ctx.userId, ...input })),
  suppress: protectedProcedure.input(z.object({ orgId, email: text(254), reason: text(40) })).mutation(({ ctx, input }) => addSuppression({ actorUserId: ctx.userId, ...input })),
  analytics: protectedProcedure.input(z.object({ orgId, days: z.coerce.number().int().optional() })).query(({ ctx, input }) => scoutAnalytics({ actorUserId: ctx.userId, ...input })),
});
