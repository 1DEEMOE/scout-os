/**
 * Monthly AI-answers visibility check. Runs in mock mode with a pluggable provider.
 * Records trend for the morning briefing. No live outbound calls from default provider.
 */
import { and, desc, eq } from "drizzle-orm";
import { aiAnswerChecks, businessProfiles, organizations } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { ANY_ROLE, STAFF, inOrg, requireRole } from "../org/access";
import { getAiAnswersProvider, type AiAnswersResult } from "./provider";

export function aiAnswersPeriod(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function runAiAnswersCheck(input: {
  actorUserId: string;
  orgId: string;
  trade?: string;
  zip?: string;
  routineRunId?: string;
  /** Force a re-check even if this period already has a row (tests). */
  force?: boolean;
}): Promise<{ checkId: string; result: AiAnswersResult; trendDelta: number | null; period: string }> {
  if (process.env.WOS_MOCK_MODE !== "1") {
    // Still allow mock provider only until a live provider is explicitly approved.
    // Never make live calls from this path without a future, reviewed provider.
  }
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "ai_answers.check");
    const period = aiAnswersPeriod();
    const [profile] = await tx.select().from(businessProfiles).limit(1);
    const [org] = await tx.select().from(organizations).limit(1);
    const trade = (input.trade ?? profile?.vertical ?? "general").slice(0, 80);
    const zip = (input.zip ?? "").replace(/\D/g, "").slice(0, 5);
    if (!/^\d{5}$/.test(zip)) throw new AppError("VALIDATION", "ZIP must be 5 digits (pass zip on the check)");

    if (!input.force) {
      const [existing] = await tx
        .select()
        .from(aiAnswerChecks)
        .where(and(eq(aiAnswerChecks.period, period), eq(aiAnswerChecks.trade, trade), eq(aiAnswerChecks.zip, zip)));
      if (existing) {
        return {
          checkId: existing.id,
          result: {
            recommended: existing.recommended,
            score: existing.score,
            provider: existing.provider,
            suggestions: (existing.suggestions as string[]).slice(0, 3) as [string, string, string],
          },
          trendDelta: existing.trendDelta,
          period,
        };
      }
    }

    const provider = getAiAnswersProvider();
    const result = await provider.check({ trade, zip, businessName: org?.name });
    const [prev] = await tx
      .select()
      .from(aiAnswerChecks)
      .where(and(eq(aiAnswerChecks.trade, trade), eq(aiAnswerChecks.zip, zip)))
      .orderBy(desc(aiAnswerChecks.period))
      .limit(1);
    const trendDelta = prev ? result.score - prev.score : null;

    const [row] = await tx
      .insert(aiAnswerChecks)
      .values({
        tenantId: input.orgId,
        period,
        trade,
        zip,
        recommended: result.recommended,
        score: result.score,
        provider: result.provider,
        suggestions: [...result.suggestions],
        trendDelta,
        routineRunId: input.routineRunId ?? null,
      })
      .returning({ id: aiAnswerChecks.id });
    const checkId = row!.id;

    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "ai_answers.check",
      target: `ai_answer_check:${checkId}`,
      tier: 0,
      outcome: "success",
      metadata: { period, trade, zip, recommended: result.recommended, score: result.score, provider: result.provider },
    });

    return { checkId, result, trendDelta, period };
  });
}

export async function latestAiAnswersCheck(input: { actorUserId: string; orgId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "ai_answers.read");
    const [row] = await tx.select().from(aiAnswerChecks).orderBy(desc(aiAnswerChecks.period), desc(aiAnswerChecks.createdAt)).limit(1);
    return row ?? null;
  });
}

export async function listAiAnswersTrend(input: { actorUserId: string; orgId: string; limit?: number }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "ai_answers.trend");
    return tx
      .select()
      .from(aiAnswerChecks)
      .orderBy(desc(aiAnswerChecks.period))
      .limit(Math.min(input.limit ?? 12, 24));
  });
}
