import { eq } from "drizzle-orm";
import { intelligenceSources, signalObservations, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { SPC_CONFIDENCE, SPC_LIMITATIONS, SPC_USAGE_RIGHTS, type SpcParseResult } from "./spc";

export interface SignalIngestResult {
  reportDay: string;
  added: number;
  duplicates: number;
  rejected: { line: number; reason: string }[];
}

/**
 * Shared SPC ingestion used by both the manual CSV upload and the automatic
 * feed: one labelled source row, the deduped signal rows ((tenant_id,
 * external_ref) UNIQUE makes re-ingesting the same day a no-op), the row
 * count, and one audit entry. Runs inside the caller's tenant transaction.
 *
 * When `skipEmptySource` is set (automatic feed), a day file with no reports
 * writes no source row at all, so quiet days don't clutter the sources list;
 * the audit row is still written when something was actually ingested.
 */
export async function ingestSpcSignals(
  tx: Tx,
  input: {
    tenantId: string;
    day: string;
    parsed: SpcParseResult;
    sourceLabel: string;
    actor: { type: "user" | "system"; id: string };
    action: string;
    demo?: boolean;
    skipEmptySource?: boolean;
  },
): Promise<SignalIngestResult> {
  if (input.skipEmptySource && input.parsed.signals.length === 0) {
    return { reportDay: input.day, added: 0, duplicates: 0, rejected: input.parsed.rejected };
  }
  const [src] = await tx
    .insert(intelligenceSources)
    .values({
      tenantId: input.tenantId,
      kind: "noaa_spc_storm_reports",
      label: input.sourceLabel.slice(0, 200),
      usageRights: SPC_USAGE_RIGHTS,
      createdBy: input.actor.id,
      demo: !!input.demo,
    })
    .returning({ id: intelligenceSources.id });
  let inserted: { id: string }[] = [];
  if (input.parsed.signals.length > 0) {
    inserted = await tx
      .insert(signalObservations)
      .values(
        input.parsed.signals.map((s) => ({
          tenantId: input.tenantId,
          sourceId: src!.id,
          kind: s.kind,
          eventAt: s.eventAt,
          location: s.location,
          county: s.county,
          state: s.state,
          lat: s.lat,
          lon: s.lon,
          magnitude: s.magnitude,
          magnitudeUnit: s.magnitudeUnit,
          comments: s.comments,
          confidence: SPC_CONFIDENCE,
          limitations: SPC_LIMITATIONS,
          externalRef: s.externalRef,
          demo: !!input.demo,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: signalObservations.id });
  }
  await tx.update(intelligenceSources).set({ rowCount: inserted.length }).where(eq(intelligenceSources.id, src!.id));
  const result: SignalIngestResult = {
    reportDay: input.day,
    added: inserted.length,
    duplicates: input.parsed.signals.length - inserted.length,
    rejected: input.parsed.rejected,
  };
  await recordAudit(tx, {
    tenantId: input.tenantId,
    actorType: input.actor.type,
    actorId: input.actor.id,
    action: input.action,
    target: `intelligence_source:${src!.id}`,
    tier: 1,
    outcome: "success",
    metadata: { reportDay: input.day, added: result.added, duplicates: result.duplicates, rejected: result.rejected.length },
  });
  return result;
}
