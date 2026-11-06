import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { communicationPermissions, opportunities, outreachEvents, prospects, suppressionList, type Tx } from "@wos/db";

/** "Ana <ANA@x.test>" → "ana@x.test". */
export function normalizeAddress(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m?.[1] ?? raw).trim().toLowerCase();
}

export type SendCheck =
  | { allowed: true; opportunityIds: Map<string, string> }
  | { allowed: false; recipient: string; reason: "suppressed" | "no_permission"; message: string; opportunityId: string | null };

/**
 * The follow-up gate (directive §10). Runs at execution time, after approval,
 * so neither an approval nor a stale draft can get around it.
 * - Anyone on the do-not-contact list: never.
 * - A Scout prospect (open opportunity): only with an active recorded permission.
 * Other recipients (ordinary replies to people who wrote in) pass.
 */
export async function checkEmailAllowed(tx: Tx, recipients: string[]): Promise<SendCheck> {
  const to = recipients.map(normalizeAddress);
  if (!to.length) return { allowed: true, opportunityIds: new Map() };
  const blocked = await tx.select({ v: suppressionList.value }).from(suppressionList).where(and(eq(suppressionList.channel, "email"), inArray(suppressionList.value, to)));
  const prospectOpps = await tx.select({ email: prospects.email, opp: opportunities.id }).from(opportunities)
    .innerJoin(prospects, and(eq(prospects.tenantId, opportunities.tenantId), eq(prospects.id, opportunities.prospectId)))
    .where(and(inArray(prospects.email, to), ne(opportunities.stage, "disqualified")));
  const opp = new Map(prospectOpps.map((r) => [r.email!, r.opp]));
  if (blocked.length) {
    const r = blocked[0]!.v;
    return { allowed: false, recipient: r, reason: "suppressed", message: `${r} is on your do-not-contact list, so this email won't be sent.`, opportunityId: opp.get(r) ?? null };
  }
  if (opp.size) {
    const ok = new Set((await tx.select({ v: communicationPermissions.value }).from(communicationPermissions)
      .where(and(eq(communicationPermissions.channel, "email"), isNull(communicationPermissions.revokedAt), inArray(communicationPermissions.value, [...opp.keys()])))).map((r) => r.v));
    const missing = [...opp.keys()].find((e) => !ok.has(e));
    if (missing) return { allowed: false, recipient: missing, reason: "no_permission", message: `There's no recorded permission to email ${missing} (a Scout prospect). Record how they agreed to hear from you first.`, opportunityId: opp.get(missing) ?? null };
  }
  return { allowed: true, opportunityIds: opp };
}

export async function recordOutreach(tx: Tx, e: { tenantId: string; opportunityId: string | null; recipient: string; kind: "sent" | "blocked"; reason?: string; actor: { type: "user" | "agent" | "system"; id: string }; ref?: string }) {
  await tx.insert(outreachEvents).values({
    tenantId: e.tenantId, opportunityId: e.opportunityId, channel: "email", recipient: e.recipient.slice(0, 254), kind: e.kind,
    reason: e.kind === "blocked" ? (e.reason ?? "blocked").slice(0, 500) : null, actorType: e.actor.type, actorId: e.actor.id, ref: e.ref?.slice(0, 300) ?? null,
  });
}
