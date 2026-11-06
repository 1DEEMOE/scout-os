import { and, countDistinct, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  agents,
  businessProfiles,
  communicationPermissions,
  contacts,
  crmRecords,
  invoices,
  opportunityEvents,
  opportunities,
  prospects,
  signalObservations,
  suppressionList,
  usageEvents,
} from "@wos/db";
import { requireFeature } from "../billing/plans";
import { inOrg, requireRole, STAFF } from "../org/access";
import { syncHandoffs } from "./lifecycle";

/**
 * Analyst (directive §12). Every number says where it comes from:
 * - observed: counted from records in this system;
 * - customer-reported: typed in by the customer, not checked;
 * - estimated: computed from customer-reported inputs; not a measurement.
 */
export type Basis = "observed" | "customer-reported" | "estimated";
export interface AnalyticsMetric {
  key: string;
  label: string;
  value: number | null;
  unit: "count" | "cents" | "micros";
  basis: Basis;
  note?: string;
}

export async function scoutAnalytics(input: { actorUserId: string; orgId: string; days?: number }) {
  const days = [7, 30, 90, 365].includes(input.days ?? 30) ? (input.days ?? 30) : 30;
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "scout.analytics.read");
    await requireFeature(tx, input.orgId, "scout", { type: "user", id: input.actorUserId }, "scout.analytics.read");
    await syncHandoffs(tx, input.orgId); // completed handoffs count before anyone opens the feed
    const since = new Date(Date.now() - days * 86_400_000);
    const n = (r: { n: number | string | null }[]) => Number(r[0]?.n ?? 0);

    const signals = n(await tx.select({ n: sql<number>`count(*)` }).from(signalObservations).where(gte(signalObservations.eventAt, since)));
    const newProspects = n(await tx.select({ n: sql<number>`count(*)` }).from(prospects).where(gte(prospects.createdAt, since)));
    const contactable = n(await tx.select({ n: sql<number>`count(DISTINCT ${prospects.id})` }).from(prospects)
      .innerJoin(communicationPermissions, and(eq(communicationPermissions.tenantId, prospects.tenantId), eq(communicationPermissions.value, prospects.email), isNull(communicationPermissions.revokedAt)))
      .where(sql`NOT EXISTS (SELECT 1 FROM ${suppressionList} s WHERE s.value = ${prospects.email})`));
    const reached = async (stage: "prospect" | "engaged" | "qualified" | "opportunity") =>
      n(await tx.select({ n: countDistinct(opportunityEvents.opportunityId) }).from(opportunityEvents).where(and(eq(opportunityEvents.toStage, stage), gte(opportunityEvents.createdAt, since))));

    // Emails of people who became opportunities (handed off), for deal and revenue attribution.
    const handedOff = (await tx.select({ email: prospects.email }).from(opportunities)
      .innerJoin(prospects, and(eq(prospects.tenantId, opportunities.tenantId), eq(prospects.id, opportunities.prospectId)))
      .where(eq(opportunities.stage, "opportunity"))).map((r) => r.email).filter((e): e is string => !!e);
    const dealsWon = handedOff.length ? n(await tx.select({ n: sql<number>`count(*)` }).from(crmRecords)
      .innerJoin(contacts, and(eq(contacts.tenantId, crmRecords.tenantId), eq(contacts.id, crmRecords.contactId)))
      .where(and(inArray(sql`lower(${contacts.email})`, handedOff), eq(crmRecords.stage, "closedwon")))) : 0;
    const revenue = handedOff.length ? n(await tx.select({ n: sql<number>`coalesce(sum(${invoices.amountDueCents}), 0)` }).from(invoices)
      .where(and(eq(invoices.status, "paid"), inArray(sql`lower(${invoices.customerEmail})`, handedOff)))) : 0;

    const scoutAgentIds = (await tx.select({ id: agents.id }).from(agents).where(eq(agents.kind, "scout"))).map((a) => a.id);
    const aiCostMicros = scoutAgentIds.length ? n(await tx.select({ n: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)` }).from(usageEvents)
      .where(and(inArray(usageEvents.agentId, scoutAgentIds), gte(usageEvents.at, since)))) : 0;

    const [profile] = await tx.select({ settings: businessProfiles.settings }).from(businessProfiles);
    const dataCostMonthly = profile?.settings.monthlyDataCostCents ?? null;
    const jobValue = profile?.settings.averageJobValueCents ?? null;
    const dataCostWindow = dataCostMonthly === null ? null : Math.round((dataCostMonthly * days) / 30);
    const opps = await reached("opportunity");
    const qualified = await reached("qualified");

    const funnel: AnalyticsMetric[] = [
      { key: "signals", label: "Storm reports", value: signals, unit: "count", basis: "observed", note: "Reports with an event time in the period." },
      { key: "prospects", label: "New prospect records", value: newProspects, unit: "count", basis: "observed" },
      { key: "matched", label: "Matched to a storm report", value: await reached("prospect"), unit: "count", basis: "observed" },
      { key: "contactable", label: "Contactable (permission recorded)", value: contactable, unit: "count", basis: "observed", note: "All time. Excludes do-not-contact." },
      { key: "engaged", label: "Engaged", value: await reached("engaged"), unit: "count", basis: "observed" },
      { key: "qualified", label: "Qualified", value: qualified, unit: "count", basis: "observed" },
      { key: "opportunities", label: "Handed to Pipeline", value: opps, unit: "count", basis: "observed" },
      { key: "won", label: "Deals won", value: dealsWon, unit: "count", basis: "observed", note: "All time. Deals marked won in your CRM for handed-off people. Attribution unverified." },
    ];
    const money: AnalyticsMetric[] = [
      { key: "revenue", label: "Paid invoices from handed-off people", value: revenue, unit: "cents", basis: "observed", note: "All time. Attribution unverified: they may have hired you anyway." },
      { key: "ai_cost", label: "Scout AI cost", value: aiCostMicros, unit: "micros", basis: "observed", note: "From metered usage at the prices configured on this server. Scans use no model, so this is usually zero." },
      { key: "data_cost", label: "Data and list cost", value: dataCostWindow, unit: "cents", basis: "customer-reported", note: dataCostMonthly === null ? "Not entered. Add it in Scout setup." : `Your monthly figure, scaled to ${days} days.` },
      {
        key: "cost_per_opportunity", label: "Cost per handed-off opportunity", unit: "cents", basis: "estimated",
        value: opps && dataCostWindow !== null ? Math.round((dataCostWindow + aiCostMicros / 10_000) / opps) : null,
        note: opps ? (dataCostWindow === null ? "Needs your data cost." : "Data cost plus AI cost, divided by opportunities.") : "No opportunities in this period.",
      },
      {
        key: "pipeline_value", label: "Possible value in Qualified + Pipeline", unit: "cents", basis: "estimated",
        value: jobValue === null ? null : jobValue * (qualified + opps),
        note: jobValue === null ? "Needs your average job value." : "Count × your average job value. Not a forecast.",
      },
    ];
    return { days, since, funnel, money };
  });
}
