import { notFound } from "next/navigation";
import { planSummary, scoutAnalytics, type AnalyticsMetric } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { Card, money, PageTitle } from "../../../ui";
import { BasisBadge, UpgradeNotice } from "../scout/parts";

export const dynamic = "force-dynamic";

function fmt(m: AnalyticsMetric) {
  if (m.value === null) return "—";
  if (m.unit === "cents") return money(m.value);
  if (m.unit === "micros") return `$${(m.value / 1e6).toFixed(2)}`;
  return m.value.toLocaleString("en-US");
}

export default async function AnalyticsPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ days?: string }> }) {
  const { orgId } = await params;
  const q = await searchParams;
  const { userId, org } = await orgContext(orgId);
  if (org.role === "viewer") notFound(); // Scout analytics is staff-only in the core
  const plan = await planSummary({ actorUserId: userId, orgId });
  const title = <PageTitle sub="How Scout's matches turn into work. Each number says where it comes from.">Analytics</PageTitle>;
  if (!plan.plan.features.includes("scout")) return <div>{title}<UpgradeNotice orgId={orgId} planLabel={plan.plan.label} /></div>;
  const a = await scoutAnalytics({ actorUserId: userId, orgId, days: Number(q.days) || 30 });
  const top = Math.max(1, ...a.funnel.map((m) => m.value ?? 0));
  return (
    <div>
      {title}
      <nav aria-label="Period" className="mb-4 flex gap-2 text-sm">
        {[7, 30, 90, 365].map((d) => (
          <a key={d} href={`?days=${d}`} aria-current={a.days === d ? "page" : undefined} className={`rounded-md border px-3 py-1 ${a.days === d ? "border-accent text-accent" : "border-line text-muted"}`}>
            {d === 365 ? "1 year" : `${d} days`}
          </a>
        ))}
      </nav>
      <div className="flex flex-col gap-4">
        <Card title="Funnel">
          <ul className="flex flex-col gap-3">
            {a.funnel.map((m) => (
              <li key={m.key} className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[minmax(16rem,22rem)_1fr_5rem] sm:items-center sm:gap-3">
                <span className="flex items-center gap-2">{m.label} <BasisBadge basis={m.basis} /></span>
                <span className="h-2 overflow-hidden rounded bg-line" aria-hidden>
                  <span className="block h-full bg-accent" style={{ width: `${Math.round(((m.value ?? 0) / top) * 100)}%` }} />
                </span>
                <span className="font-semibold tabular-nums sm:text-right">{fmt(m)}</span>
                {m.note && <span className="text-xs text-muted sm:col-span-3">{m.note}</span>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Money">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {a.money.map((m) => (
              <div key={m.key} className="rounded-md border border-line p-3">
                <dt className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">{m.label} <BasisBadge basis={m.basis} /></dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">{fmt(m)}</dd>
                {m.note && <dd className="mt-1 text-xs text-muted">{m.note}</dd>}
              </div>
            ))}
          </dl>
        </Card>
        <p className="text-xs text-muted">Observed: counted from your records. Customer-reported: numbers you entered in Scout setup, not checked. Estimated: calculated from your numbers; not a measurement or a forecast.</p>
      </div>
    </div>
  );
}
