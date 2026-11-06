import { getSubscription, listAgents, planSummary, usageSummary, type Metric } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { ActionButton, ActionForm } from "../../../actions";
import { Badge, Card, Empty, inputCls, PageTitle, When } from "../../../ui";

export const dynamic = "force-dynamic";

const usd = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;

const QUOTA_ROWS: { metric: Metric; label: string }[] = [
  { metric: "tasks", label: "Tasks" },
  { metric: "scout.opportunities", label: "New Scout opportunities" },
  { metric: "scout.prospect_rows", label: "Imported prospect rows" },
];

/** One allowance line. limit null = no limit on this plan. */
function Allowance({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <dt className="flex justify-between text-muted">
        <span>{label}</span>
        <span className="text-ink">{used.toLocaleString("en-US")} {limit === null ? "· no limit" : `of ${limit.toLocaleString("en-US")}`}</span>
      </dt>
      {limit !== null && (
        <dd className="mt-1 h-1.5 w-full overflow-hidden rounded bg-line" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full ${pct >= 90 ? "bg-danger" : "bg-accent"}`} style={{ width: `${pct}%` }} />
        </dd>
      )}
    </div>
  );
}

export default async function BillingPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ checkout?: string }> }) {
  const { orgId } = await params;
  const q = await searchParams;
  const { userId, isOwner } = await orgContext(orgId);
  const [usage, plan, sub, agents] = await Promise.all([
    usageSummary({ actorUserId: userId, orgId }),
    planSummary({ actorUserId: userId, orgId }),
    getSubscription({ actorUserId: userId, orgId }),
    listAgents({ actorUserId: userId, orgId }),
  ]);
  const pct = usage.budgetMicros ? Math.min(100, Math.round((usage.spentMicros / usage.budgetMicros) * 100)) : 100;
  const name = (id: string | null) => agents.find((a) => a.id === id)?.displayName ?? "Routing";
  return (
    <div className="flex flex-col gap-6">
      <PageTitle sub={`Usage for ${usage.period}. AI work stops for the month when the budget is reached, before any further model call.`}>Billing</PageTitle>
      {q.checkout === "success" && <p role="status" className="text-sm text-accent">Thanks. Your subscription will show here once Stripe confirms it.</p>}
      <Card title="AI spend this month">
        <div className="mb-2 flex items-baseline justify-between text-sm">
          <span className="text-2xl font-semibold">{usd(usage.spentMicros)}</span>
          <span className="text-muted">of {usd(usage.budgetMicros)} budget</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded bg-line" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Budget used">
          <div className={`h-full ${pct >= 90 ? "bg-danger" : "bg-accent"}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-xs text-muted">Costs use the per-token prices configured on this server; check them against your model provider's current price list.</p>
        {usage.byAgent.length > 0 && (
          <ul className="mt-4 divide-y divide-line text-sm">
            {usage.byAgent.map((a) => (
              <li key={a.agentId ?? "none"} className="flex justify-between py-2"><span>{name(a.agentId)}</span><span>{usd(a.costMicros)} · {a.calls} calls</span></li>
            ))}
          </ul>
        )}
        {isOwner && (
          <div className="mt-4">
            <ActionForm path="billing.setBudget" fixed={{ orgId }} submitLabel="Set monthly budget">
              <label className="flex flex-col gap-1 text-sm">Monthly AI budget (US cents)
                <input name="budgetCents" type="number" min={0} max={1000000} required defaultValue={Math.round(usage.budgetMicros / 10_000)} className={`${inputCls} w-48`} />
              </label>
            </ActionForm>
          </div>
        )}
      </Card>
      <Card title={<span className="flex flex-wrap items-center gap-2">Plan: {plan.plan.label} {plan.pastDue && <Badge tone="danger">payment failed</Badge>}</span>}>
        {plan.pastDue && (
          <p role="alert" className="mb-3 rounded-md border border-danger/50 bg-danger/10 px-3 py-2 text-sm">
            Stripe couldn&apos;t take the last payment. Your plan stays active for now; update the card in Stripe to keep it.
          </p>
        )}
        <dl className="mb-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <Allowance label="Seats" used={plan.seatsUsed} limit={plan.plan.limits.seats} />
          {QUOTA_ROWS.filter((m) => plan.plan.limits[m.metric] !== 0).map((m) => (
            <Allowance key={m.metric} label={`${m.label} this month`} used={plan.usage[m.metric]} limit={plan.plan.limits[m.metric]} />
          ))}
        </dl>
        {!plan.plan.features.includes("scout") && (
          <p className="mb-3 text-sm text-muted">Scout lead intelligence is part of the Scout Pro and Enterprise plans.</p>
        )}
        {sub ? (
          <p className="text-sm">Subscription <Badge tone={sub.status === "active" ? "accent" : "warn"}>{sub.status}</Badge> renews <When date={sub.currentPeriodEnd} /></p>
        ) : (
          <>
            <Empty>No subscription yet.</Empty>
            {isOwner && <div className="mt-3"><ActionButton path="billing.checkout" input={{ orgId }} label="Subscribe with Stripe" variant="primary" /></div>}
          </>
        )}
      </Card>
    </div>
  );
}
