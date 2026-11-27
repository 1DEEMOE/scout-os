import { z } from "zod";
import {
  ACTIVE_STATUSES,
  JOB_STATUSES,
  advanceJob,
  assignCrew,
  cancelJob,
  confirmJobsPricing,
  createJob,
  dispatchJob,
  getJob,
  jobFormConfig,
  listJobs,
  prepareEstimate,
  recordJobOutcome,
  requestEstimateSend,
  returnEstimateToDraft,
  saveJobsBusinessFields,
  scheduleJob,
} from "@wos/core";
import { protectedProcedure, router } from "../trpc";

const orgId = z.string().max(64);
const jobId = z.string().max(64);

/** Intake answers: keys and values bounded so a browser can't stuff the interim store. */
const answersSchema = z.record(
  z.string().regex(/^[a-z0-9_]+$/).max(40),
  z.union([z.string().max(200), z.number(), z.boolean()]),
);

export const jobsRouter = router({
  list: protectedProcedure
    // `jobStatus`, not `status`: the shared endpoint-isolation probe bag already uses `status` for another enum.
    .input(z.object({ orgId, jobStatus: z.enum(JOB_STATUSES).optional() }))
    .query(({ ctx, input }) => listJobs({ actorUserId: ctx.userId, orgId: input.orgId, status: input.jobStatus })),

  get: protectedProcedure
    .input(z.object({ orgId, jobId }))
    .query(({ ctx, input }) => getJob({ actorUserId: ctx.userId, ...input })),

  formConfig: protectedProcedure
    .input(z.object({ orgId }))
    .query(({ ctx, input }) => jobFormConfig({ actorUserId: ctx.userId, ...input })),

  create: protectedProcedure
    .input(
      z.object({
        orgId,
        customerName: z.string().min(1).max(120),
        customerEmail: z.string().email().max(200).optional().or(z.literal("")),
        customerPhone: z.string().max(40).optional(),
        answers: answersSchema,
      }),
    )
    .mutation(({ ctx, input }) =>
      createJob({
        actorUserId: ctx.userId,
        orgId: input.orgId,
        customerName: input.customerName,
        customerEmail: input.customerEmail || undefined,
        customerPhone: input.customerPhone,
        answers: input.answers,
      }),
    ),

  prepareEstimate: protectedProcedure
    .input(z.object({ orgId, jobId }))
    .mutation(({ ctx, input }) => prepareEstimate({ actorUserId: ctx.userId, ...input })),

  sendEstimate: protectedProcedure
    .input(z.object({ orgId, jobId }))
    .mutation(({ ctx, input }) => requestEstimateSend({ actorUserId: ctx.userId, ...input })),

  returnToDraft: protectedProcedure
    .input(z.object({ orgId, jobId }))
    .mutation(({ ctx, input }) => returnEstimateToDraft({ actorUserId: ctx.userId, ...input })),

  outcome: protectedProcedure
    // `result`, not `outcome`: the audit router already owns `outcome` with a different enum.
    .input(z.object({ orgId, jobId, result: z.enum(["booked", "lost"]) }))
    .mutation(({ ctx, input }) => recordJobOutcome({ actorUserId: ctx.userId, orgId: input.orgId, jobId: input.jobId, outcome: input.result })),

  schedule: protectedProcedure
    .input(z.object({ orgId, jobId, scheduledFor: z.string().datetime().nullable() }))
    .mutation(({ ctx, input }) =>
      scheduleJob({ actorUserId: ctx.userId, orgId: input.orgId, jobId: input.jobId, scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null }),
    ),

  assignCrew: protectedProcedure
    .input(z.object({ orgId, jobId, memberIds: z.array(z.string().max(64)).max(20) }))
    .mutation(({ ctx, input }) => assignCrew({ actorUserId: ctx.userId, ...input })),

  dispatch: protectedProcedure
    .input(z.object({ orgId, jobId }))
    .mutation(({ ctx, input }) => dispatchJob({ actorUserId: ctx.userId, ...input })),

  advance: protectedProcedure
    .input(z.object({ orgId, jobId, to: z.enum(["in_progress", "done"]) }))
    .mutation(({ ctx, input }) => advanceJob({ actorUserId: ctx.userId, ...input })),

  cancel: protectedProcedure
    .input(z.object({ orgId, jobId }))
    .mutation(({ ctx, input }) => cancelJob({ actorUserId: ctx.userId, ...input })),

  confirmPricing: protectedProcedure
    .input(
      z.object({
        orgId,
        overrides: z
          .record(
            z.string().regex(/^[a-z0-9_]+$/),
            z.object({
              cents: z.number().int().min(0).max(100_000_000).optional(),
              unitCents: z.number().int().min(0).max(100_000_000).optional(),
              bps: z.number().int().min(1).max(10000).optional(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => confirmJobsPricing({ actorUserId: ctx.userId, ...input })),

  saveBusinessFields: protectedProcedure
    .input(z.object({ orgId, fields: z.record(z.string().regex(/^[a-z0-9_]+$/), z.string().max(120)) }))
    .mutation(({ ctx, input }) => saveJobsBusinessFields({ actorUserId: ctx.userId, ...input })),
});

export { ACTIVE_STATUSES };
