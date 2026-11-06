import { withTenant } from "@wos/db";
import { confirmFrontDeskBooking, FRONT_DESK_BOOKING_MIN_TIER, FRONT_DESK_TOOL } from "../front-desk/service";
import { clearFlaggedDocument, FORGERY_MIN_TIER, FORGERY_REVIEW_TOOL } from "../documents/forgery";
import { z } from "zod";
import { objectResult, type ToolDefinition, type ToolRegistry } from "../engine/tools";

export function frontDeskTools(): ToolDefinition[] {
  const confirm: ToolDefinition<{ bookingId: string }> = {
    name: FRONT_DESK_TOOL,
    description: "Confirm a front-desk booking after human approval. Never auto-runs.",
    tier: FRONT_DESK_BOOKING_MIN_TIER,
    output: objectResult,
    args: z.object({ bookingId: z.uuid() }),
    summarize: (a) => `Confirm front-desk booking ${a.bookingId.slice(0, 8)}`,
    async execute(ctx, a) {
      return withTenant(ctx.tenantId, (tx) => confirmFrontDeskBooking(tx, ctx.tenantId, a.bookingId));
    },
  };
  return [confirm];
}

export function forgeryTools(): ToolDefinition[] {
  const review: ToolDefinition<{ documentId: string }> = {
    name: FORGERY_REVIEW_TOOL,
    description: "Mark a flagged invoice/estimate as reviewed. Never pays the vendor.",
    tier: FORGERY_MIN_TIER,
    output: z.object({ documentId: z.string(), paid: z.literal(false) }).strict(),
    args: z.object({ documentId: z.uuid() }),
    summarize: (a) => `Clear flagged document ${a.documentId.slice(0, 8)} after review (no payment)`,
    async execute(ctx, a) {
      await withTenant(ctx.tenantId, (tx) => clearFlaggedDocument(tx, ctx.tenantId, a.documentId));
      return { documentId: a.documentId, paid: false };
    },
  };
  return [review];
}

export function registerFrontDeskTools(registry: ToolRegistry): void {
  registry.register(...frontDeskTools(), ...forgeryTools());
}
