import { headers } from "next/headers";
import { z } from "zod";
import { createCheckout, getSubscription, planSummary, setMonthlyBudget, usageSummary } from "@wos/core";
import { protectedProcedure, router } from "../trpc";

const orgId = z.string().max(64);

export const billingRouter = router({
  usage: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => usageSummary({ actorUserId: ctx.userId, ...input })),
  plan: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => planSummary({ actorUserId: ctx.userId, ...input })),
  subscription: protectedProcedure.input(z.object({ orgId })).query(({ ctx, input }) => getSubscription({ actorUserId: ctx.userId, ...input })),
  setBudget: protectedProcedure
    .input(z.object({ orgId, budgetCents: z.coerce.number().int().min(0).max(1_000_000) }))
    .mutation(({ ctx, input }) => setMonthlyBudget({ actorUserId: ctx.userId, ...input })),
  checkout: protectedProcedure.input(z.object({ orgId })).mutation(async ({ ctx, input }) => {
    const base = process.env.BETTER_AUTH_URL ?? `https://${(await headers()).get("host")}`;
    return createCheckout({ actorUserId: ctx.userId, orgId: input.orgId, returnUrl: `${base}/orgs/${input.orgId}/billing` });
  }),
});
