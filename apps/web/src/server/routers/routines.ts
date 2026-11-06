import { z } from "zod";
import {
  createRoutine,
  getRoutine,
  latestBriefing,
  listRoutines,
  recoverLostRoutinesAsManager,
  runRoutineNow,
  setRoutinePaused,
} from "@wos/core";
import { protectedProcedure, router } from "../trpc";

const orgId = z.string().max(64);
const id = z.string().max(64);

export const routinesRouter = router({
  list: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => listRoutines({ actorUserId: ctx.userId, ...input })),
  get: protectedProcedure.input(z.object({ orgId, routineId: id })).query(({ ctx, input }) => getRoutine({ actorUserId: ctx.userId, ...input })),
  briefing: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => latestBriefing({ actorUserId: ctx.userId, ...input })),
  create: protectedProcedure
    .input(z.object({ orgId, kind: z.literal("morning_briefing"), name: z.string().max(200), hour: z.coerce.number().int(), minute: z.coerce.number().int(), daysOfWeek: z.array(z.coerce.number().int()).max(7), timezone: z.string().max(64) }))
    .mutation(({ ctx, input }) => createRoutine({ actorUserId: ctx.userId, ...input })),
  pause: protectedProcedure.input(z.object({ orgId, routineId: id })).mutation(({ ctx, input }) => setRoutinePaused({ actorUserId: ctx.userId, ...input, paused: true })),
  resume: protectedProcedure.input(z.object({ orgId, routineId: id })).mutation(({ ctx, input }) => setRoutinePaused({ actorUserId: ctx.userId, ...input, paused: false })),
  runNow: protectedProcedure.input(z.object({ orgId, routineId: id, clientRef: z.string().max(64) })).mutation(({ ctx, input }) => runRoutineNow({ actorUserId: ctx.userId, ...input })),
  /** Re-queue lost scheduled runs for this org. Idempotent; audits every recovery. */
  recoverLost: protectedProcedure.input(z.object({ orgId })).mutation(({ ctx, input }) => recoverLostRoutinesAsManager({ actorUserId: ctx.userId, orgId: input.orgId })),
});
