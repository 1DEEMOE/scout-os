import { randomUUID } from "node:crypto";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { AppError, logger, type AppErrorCode } from "@wos/core";
import { ensureEngine } from "./engine";

export interface Context {
  userId: string | null;
  requestId: string;
}

export function makeContext(userId: string | null): Context {
  return { userId, requestId: randomUUID() };
}

const t = initTRPC.context<Context>().create({ transformer: superjson });

const CODE_MAP: Record<AppErrorCode, TRPCError["code"]> = {
  VALIDATION: "BAD_REQUEST",
  UNAUTHENTICATED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  UPGRADE_REQUIRED: "PAYMENT_REQUIRED",
  QUOTA_EXCEEDED: "PAYMENT_REQUIRED",
};

/** Turns typed app errors into tRPC errors; anything else is logged and hidden. */
const errors = t.middleware(async ({ ctx, path, next }) => {
  const result = await next();
  if (!result.ok) {
    const cause = result.error.cause;
    if (cause instanceof AppError) {
      throw new TRPCError({ code: CODE_MAP[cause.code], message: cause.message, cause });
    }
    if (result.error.code === "INTERNAL_SERVER_ERROR") {
      logger.error({ err: cause ?? result.error, path, requestId: ctx.requestId, userId: ctx.userId }, "request failed");
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Something went wrong (ref ${ctx.requestId})` });
    }
  }
  return result;
});

const authed = t.middleware(({ ctx, next }) => {
  if (!ctx.userId) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to continue" });
  ensureEngine();
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const protectedProcedure = t.procedure.use(errors).use(authed);
