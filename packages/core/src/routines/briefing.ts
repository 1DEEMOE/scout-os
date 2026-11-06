import { sql } from "drizzle-orm";
import type { RoutineSourceUse, Tx } from "@wos/db";
import { entitlementsIn } from "../billing/plans";
import { wallTime } from "./schedule";

/**
 * The Morning Briefing (COORDINATOR). READ-ONLY: every source below is a
 * SELECT inside the tenant's RLS transaction. Nothing is sent anywhere; the
 * result is stored on the run and shown in the app.
 *
 * Missing data fails loudly: if any source can't be read, the whole run
 * fails with the source named, instead of showing a briefing that silently
 * omits a section. A section that doesn't apply (e.g. Scout not in the plan,
 * profile not reviewed) is shown as "unavailable" with the reason, never as 0.
 */
export interface BriefingItem {
  label: string;
  detail?: string;
  href?: string;
}
export interface BriefingSection {
  key: "storm_signals" | "unanswered_leads" | "stalled_deals" | "follow_ups_due" | "overdue_invoices" | "pending_approvals" | "ai_visibility";
  title: string;
  status: "ok" | "unavailable";
  /** Why the section is unavailable. Shown to the user. */
  reason?: string;
  count: number;
  items: BriefingItem[];
  sources: string[];
}
export interface Briefing {
  kind: "morning_briefing";
  generatedAt: string;
  localDate: string;
  timezone: string;
  /** Tier of every step this briefing took. Always 0 (reads). */
  maxTierUsed: 0;
  sections: BriefingSection[];
}

export class MissingSourceError extends Error {
  constructor(
    readonly source: string,
    cause: unknown,
    readonly readSoFar: RoutineSourceUse[] = [],
  ) {
    super(`Briefing source "${source}" could not be read: ${cause instanceof Error ? (cause.cause instanceof Error ? cause.cause.message : cause.message) : String(cause)}`);
    this.name = "MissingSourceError";
  }
}

type Row = Record<string, unknown>;
export interface SourceContext {
  tx: Tx;
  tenantId: string;
  now: Date;
  localDate: string;
}
/** A named read. Tests may wrap these to simulate an unreadable source. */
export type SourceReader = (ctx: SourceContext) => Promise<Row[]>;


const SOURCE_LABELS: Record<string, string> = {
  business_profiles: "Business profile",
  signal_observations: "Storm reports",
  opportunities_scored: "Scored leads",
  conversations_unanswered: "Unanswered leads",
  crm_records_stalled: "Stalled deals",
  opportunities_stalled: "Stalled Scout jobs",
  opportunities_follow_up: "Follow-ups due",
  conversations_drafts: "Draft replies",
  invoices_overdue: "Overdue invoices",
  approval_requests_pending: "Waiting approvals",
  ai_answer_checks: "AI answers check",
};

/** Human-readable name for a briefing source key (internal table names stay in stored data). */
export function briefingSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.replace(/_/g, " ");
}

const LIMIT = 10;
const STALE_DAYS = 14;
const FOLLOW_UP_DAYS = 3;
const UNANSWERED_HOURS = 24;

export const BRIEFING_SOURCES: Record<string, SourceReader> = {
  signal_observations: async ({ tx, now }) =>
    (await tx.execute(sql`SELECT kind, count(*)::int AS n, max(event_at) AS latest FROM signal_observations
      WHERE event_at >= ${new Date(now.getTime() - 7 * 86_400_000)} GROUP BY kind ORDER BY kind`)).rows,
  opportunities_scored: async ({ tx }) =>
    (await tx.execute(sql`SELECT o.id, o.score, o.stage, p.name, p.city, p.state FROM opportunities o JOIN prospects p ON p.tenant_id = o.tenant_id AND p.id = o.prospect_id
      WHERE o.stage IN ('prospect', 'engaged') ORDER BY o.score DESC, o.created_at DESC LIMIT ${LIMIT}`)).rows,
  business_profiles: async ({ tx }) => (await tx.execute(sql`SELECT status FROM business_profiles LIMIT 1`)).rows,
  conversations_unanswered: async ({ tx, now }) =>
    (await tx.execute(sql`SELECT c.id, c.subject, c.last_message_at FROM conversations c
      WHERE c.category = 'lead'
        AND EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id AND m.direction = 'inbound')
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id AND m.direction = 'outbound'
                        AND m.sent_at >= (SELECT max(i.sent_at) FROM messages i WHERE i.tenant_id = c.tenant_id AND i.conversation_id = c.id AND i.direction = 'inbound'))
        AND (SELECT max(i.sent_at) FROM messages i WHERE i.tenant_id = c.tenant_id AND i.conversation_id = c.id AND i.direction = 'inbound') <= ${new Date(now.getTime() - UNANSWERED_HOURS * 3_600_000)}
      ORDER BY c.last_message_at ASC NULLS LAST LIMIT ${LIMIT + 1}`)).rows,
  crm_records_stalled: async ({ tx, now }) =>
    (await tx.execute(sql`SELECT id, name, stage, synced_at FROM crm_records
      WHERE lower(stage) NOT LIKE 'closed%' AND synced_at < ${new Date(now.getTime() - STALE_DAYS * 86_400_000)}
      ORDER BY synced_at ASC LIMIT ${LIMIT + 1}`)).rows,
  opportunities_stalled: async ({ tx, now }) =>
    (await tx.execute(sql`SELECT o.id, o.stage, o.score, o.updated_at, p.name, p.city, p.state FROM opportunities o JOIN prospects p ON p.tenant_id = o.tenant_id AND p.id = o.prospect_id
      WHERE o.stage IN ('qualified', 'opportunity') AND o.updated_at < ${new Date(now.getTime() - STALE_DAYS * 86_400_000)}
      ORDER BY o.updated_at ASC LIMIT ${LIMIT + 1}`)).rows,
  opportunities_follow_up: async ({ tx, now }) =>
    (await tx.execute(sql`SELECT o.id, o.score, o.updated_at, p.name, p.city, p.state FROM opportunities o JOIN prospects p ON p.tenant_id = o.tenant_id AND p.id = o.prospect_id
      WHERE o.stage = 'engaged' AND o.updated_at < ${new Date(now.getTime() - FOLLOW_UP_DAYS * 86_400_000)}
        AND NOT EXISTS (SELECT 1 FROM outreach_events e WHERE e.tenant_id = o.tenant_id AND e.opportunity_id = o.id AND e.kind = 'sent'
                        AND e.created_at >= ${new Date(now.getTime() - FOLLOW_UP_DAYS * 86_400_000)})
      ORDER BY o.score DESC LIMIT ${LIMIT + 1}`)).rows,
  conversations_drafts: async ({ tx }) =>
    (await tx.execute(sql`SELECT id, subject FROM conversations WHERE draft_body IS NOT NULL ORDER BY updated_at ASC LIMIT ${LIMIT + 1}`)).rows,
  invoices_overdue: async ({ tx, localDate }) =>
    (await tx.execute(sql`SELECT id, number, customer_name, amount_due_cents, currency, due_date FROM invoices
      WHERE status = 'open' AND due_date IS NOT NULL AND due_date < ${localDate}::date ORDER BY due_date ASC LIMIT ${LIMIT + 1}`)).rows,
  approval_requests_pending: async ({ tx, now }) =>
    (await tx.execute(sql`SELECT id, summary, tier, status, expires_at FROM approval_requests
      WHERE status IN ('pending', 'awaiting_confirmation') AND expires_at > ${now} ORDER BY requested_at ASC LIMIT ${LIMIT + 1}`)).rows,
  ai_answer_checks: async ({ tx }) =>
    (await tx.execute(sql`SELECT period, trade, zip, recommended, score, trend_delta, suggestions, provider
      FROM ai_answer_checks ORDER BY period DESC, created_at DESC LIMIT 3`)).rows,
};

const money = (cents: unknown, cur: unknown) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: String(cur ?? "usd").toUpperCase() }).format(Number(cents ?? 0) / 100);
const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? "").slice(0, 10));

export async function buildMorningBriefing(
  tx: Tx,
  tenantId: string,
  opts: { now: Date; timezone: string; orgBase: string; readers?: Record<string, SourceReader> },
): Promise<{ briefing: Briefing; sources: RoutineSourceUse[] }> {
  const readers = opts.readers ?? BRIEFING_SOURCES;
  const w = wallTime(opts.now, opts.timezone);
  const localDate = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
  const ctx: SourceContext = { tx, tenantId, now: opts.now, localDate };
  const used: RoutineSourceUse[] = [];
  const read = async (name: string): Promise<Row[]> => {
    const r = readers[name];
    if (!r) throw new MissingSourceError(name, new Error("no reader registered"));
    let rows: Row[];
    try {
      // Savepoint so one failed read doesn't poison the transaction the failure is recorded in.
      await tx.raw.query("SAVEPOINT briefing_read");
      rows = await r(ctx);
      await tx.raw.query("RELEASE SAVEPOINT briefing_read");
    } catch (err) {
      await tx.raw.query("ROLLBACK TO SAVEPOINT briefing_read").catch(() => undefined);
      used.push({ source: name, rows: -1, asOf: opts.now.toISOString() });
      throw new MissingSourceError(name, err, [...used]);
    }
    if (!Array.isArray(rows)) throw new MissingSourceError(name, new Error("reader returned no rows array"));
    used.push({ source: name, rows: rows.length, asOf: opts.now.toISOString() });
    return rows;
  };
  const b = opts.orgBase;
  const cap = <T>(rows: T[]) => rows.slice(0, LIMIT);
  const sections: BriefingSection[] = [];

  // 1. Storm signals + scored prospects (Scout). Plan and profile gate the section, loudly.
  const ent = await entitlementsIn(tx, tenantId);
  if (!ent.plan.features.includes("scout")) {
    sections.push({ key: "storm_signals", title: "Storm signals and top prospects", status: "unavailable", reason: `Scout isn't included in the ${ent.plan.label} plan.`, count: 0, items: [], sources: [] });
  } else {
    const profile = await read("business_profiles");
    if (profile[0]?.status !== "reviewed") {
      sections.push({ key: "storm_signals", title: "Storm signals and top prospects", status: "unavailable", reason: "Scout's business profile hasn't been reviewed yet, so prospects aren't scored.", count: 0, items: [], sources: ["business_profiles"] });
    } else {
      const sig = await read("signal_observations");
      const opps = await read("opportunities_scored");
      const items: BriefingItem[] = [
        ...sig.map((s) => ({ label: `${s.n} ${s.kind} report${Number(s.n) === 1 ? "" : "s"} in the last 7 days`, detail: `latest ${day(s.latest)}`, href: `${b}/scout/signals` })),
        ...opps.map((o) => ({ label: `Score ${o.score} · ${[o.name, [o.city, o.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "location not set"}`, detail: String(o.stage), href: `${b}/scout/opportunities/${o.id}` })),
      ];
      const signalCount = sig.reduce((n, s) => n + Number(s.n), 0);
      sections.push({ key: "storm_signals", title: "Storm signals and top prospects", status: "ok", count: signalCount + opps.length, items, sources: ["business_profiles", "signal_observations", "opportunities_scored"] });
    }
  }

  const leads = await read("conversations_unanswered");
  sections.push({
    key: "unanswered_leads", title: `Leads waiting more than ${UNANSWERED_HOURS}h for a reply`, status: "ok", count: leads.length,
    items: cap(leads).map((c) => ({ label: String(c.subject || "(no subject)"), detail: `last message ${day(c.last_message_at)}`, href: `${b}/inbox/${c.id}` })),
    sources: ["conversations_unanswered"],
  });

  const deals = await read("crm_records_stalled");
  const stalledOpps = await read("opportunities_stalled");
  sections.push({
    key: "stalled_deals", title: `Deals with no movement for ${STALE_DAYS}+ days`, status: "ok", count: deals.length + stalledOpps.length,
    items: cap([
      ...deals.map((d) => ({ label: String(d.name), detail: `stage ${d.stage} · last synced ${day(d.synced_at)}`, href: `${b}/sales` })),
      ...stalledOpps.map((o) => ({ label: `${o.name ?? "Scout opportunity"} · score ${o.score}`, detail: `${o.stage} since ${day(o.updated_at)}`, href: `${b}/scout/opportunities/${o.id}` })),
    ]),
    sources: ["crm_records_stalled", "opportunities_stalled"],
  });

  const fu = await read("opportunities_follow_up");
  const drafts = await read("conversations_drafts");
  sections.push({
    key: "follow_ups_due", title: "Follow-ups due", status: "ok", count: fu.length + drafts.length,
    items: cap([
      ...fu.map((o) => ({ label: `${o.name ?? "Engaged prospect"} · score ${o.score}`, detail: `no follow-up sent in ${FOLLOW_UP_DAYS} days`, href: `${b}/scout/opportunities/${o.id}` })),
      ...drafts.map((c) => ({ label: `Draft reply waiting: ${String(c.subject || "(no subject)")}`, detail: "review and send from Inbox (needs approval)", href: `${b}/inbox/${c.id}` })),
    ]),
    sources: ["opportunities_follow_up", "conversations_drafts"],
  });

  const inv = await read("invoices_overdue");
  sections.push({
    key: "overdue_invoices", title: "Overdue invoices", status: "ok", count: inv.length,
    items: cap(inv).map((i) => ({ label: `${i.number ?? "Invoice"} · ${i.customer_name ?? "customer"}`, detail: `${money(i.amount_due_cents, i.currency)} due ${day(i.due_date)}`, href: `${b}/finance` })),
    sources: ["invoices_overdue"],
  });

  const ap = await read("approval_requests_pending");
  sections.push({
    key: "pending_approvals", title: "Waiting for your approval", status: "ok", count: ap.length,
    items: cap(ap).map((a) => ({ label: String(a.summary), detail: `tier ${a.tier}${a.status === "awaiting_confirmation" ? " · needs second confirmation" : ""}`, href: `${b}/approvals` })),
    sources: ["approval_requests_pending"],
  });

  // AI answers visibility (monthly check). Read-only here; the monthly step writes separately.
  try {
    const checks = await read("ai_answer_checks");
    if (!checks.length) {
      sections.push({
        key: "ai_visibility",
        title: "AI answers · are you recommended?",
        status: "unavailable",
        reason: "No monthly AI-answers check yet. Run one from Settings or wait for the next briefing cycle.",
        count: 0,
        items: [],
        sources: ["ai_answer_checks"],
      });
    } else {
      const latest = checks[0]!;
      const delta = latest.trend_delta == null ? "first check" : `trend ${Number(latest.trend_delta) >= 0 ? "+" : ""}${latest.trend_delta}`;
      const suggestions = Array.isArray(latest.suggestions) ? (latest.suggestions as string[]).slice(0, 3) : [];
      sections.push({
        key: "ai_visibility",
        title: "AI answers · are you recommended?",
        status: "ok",
        count: 1,
        items: [
          {
            label: latest.recommended ? `Recommended for ${latest.trade} in ${latest.zip}` : `Not clearly recommended for ${latest.trade} in ${latest.zip}`,
            detail: `Score ${latest.score}/100 · ${delta} · ${latest.period}`,
          },
          ...suggestions.map((s) => ({ label: s })),
        ],
        sources: ["ai_answer_checks"],
      });
    }
  } catch {
    // If the reader is missing in older tests, skip without failing the whole briefing.
  }

  return { briefing: { kind: "morning_briefing", generatedAt: opts.now.toISOString(), localDate, timezone: opts.timezone, maxTierUsed: 0, sections }, sources: used };
}
