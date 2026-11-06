import { getBusinessProfile, listOpportunities, listSignals, planSummary } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { ActionButton } from "../../../actions";
import { Card, Empty, PageTitle, When } from "../../../ui";
import { DemoBadge, ScoreCell, ScoutTabs, StageBadge, STAGE_LABEL, UpgradeNotice } from "./parts";

export const dynamic = "force-dynamic";

const STAGES = ["prospect", "engaged", "qualified", "opportunity", "disqualified"] as const;

export default async function ScoutPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ stage?: string }> }) {
  const { orgId } = await params;
  const { stage } = await searchParams;
  const { userId, isManager, org } = await orgContext(orgId);
  const plan = await planSummary({ actorUserId: userId, orgId });
  const title = <PageTitle sub="Possible jobs from your own records and public storm reports. Every score is explained. Scout never contacts anyone.">Scout</PageTitle>;
  if (!plan.plan.features.includes("scout")) return <div>{title}<UpgradeNotice orgId={orgId} planLabel={plan.plan.label} /></div>;

  const filter = STAGES.includes(stage as (typeof STAGES)[number]) ? stage : undefined;
  const [profile, all, signals] = await Promise.all([
    getBusinessProfile({ actorUserId: userId, orgId }),
    listOpportunities({ actorUserId: userId, orgId, limit: 500 }),
    listSignals({ actorUserId: userId, orgId, limit: 1 }),
  ]);
  const rows = filter ? all.filter((o) => o.stage === filter) : all.filter((o) => o.stage !== "disqualified");
  const count = (s: string) => all.filter((o) => o.stage === s).length;
  const oppLimit = plan.plan.limits["scout.opportunities"];
  const ready = profile?.status === "reviewed";

  return (
    <div>
      {title}
      <ScoutTabs orgId={orgId} active="feed" role={org.role} />
      {!ready && (
        <div role="status" className="mb-4 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          {profile ? "Your business profile is a draft." : "Set up your business profile first."} Scout won&apos;t scan until a manager reviews it.{" "}
          <a className="underline" href={`/orgs/${orgId}/scout/setup`}>Go to setup</a>
        </div>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(["prospect", "engaged", "qualified", "opportunity"] as const).map((s) => (
          <a key={s} href={`?stage=${s}`} className={`rounded-md border p-5 hover:bg-line/30 ${filter === s ? "border-accent" : "border-line"}`}>
            <div className="text-2xl font-semibold tabular-nums">{count(s)}</div>
            <div className="text-sm text-muted">{STAGE_LABEL[s]}</div>
          </a>
        ))}
      </div>
      <Card
        title={<span className="flex flex-wrap items-center gap-2">{filter ? STAGE_LABEL[filter] : "Open opportunities"} {filter && <a href="?" className="text-xs font-normal text-muted underline">show all open</a>}</span>}
        actions={
          <span className="flex flex-wrap items-center gap-3 text-sm text-muted">
            {oppLimit !== null && <span>{plan.usage["scout.opportunities"]} of {oppLimit} new this month</span>}
            {ready && <ActionButton path="scout.scan" input={{ orgId }} label="Run a scan" redirectToTask={{ orgId }} variant="primary" />}
          </span>
        }
      >
        {rows.length === 0 ? (
          <Empty>
            {all.length === 0
              ? signals.length === 0
                ? "No storm reports yet. Upload a NOAA SPC report in Setup, import your prospect list, then run a scan."
                : "No matches yet. Run a scan after importing your prospects."
              : "Nothing in this stage."}
          </Empty>
        ) : (
          <>
          {/* Phones: one card per opportunity. */}
          <ul className="divide-y divide-line sm:hidden">
            {rows.map((o) => {
              const ev = (o.explanation as { evidence?: { description: string; distanceMiles: number | null }[] }).evidence?.[0];
              return (
                <li key={o.id} className="flex flex-col gap-2 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <a className="font-medium underline" href={`/orgs/${orgId}/scout/opportunities/${o.id}`}>{o.prospect.name}</a>
                      <div className="text-sm text-muted">{[o.prospect.city, o.prospect.state].filter(Boolean).join(", ")}</div>
                    </div>
                    <div className="w-24 shrink-0"><ScoreCell score={o.score} breakdown={o.scoreBreakdown} /></div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2"><StageBadge stage={o.stage} /> {o.demo && <DemoBadge />}</div>
                  {ev && <p className="text-sm text-muted">{ev.description}, {ev.distanceMiles === null ? "same county" : `${ev.distanceMiles} mi`}</p>}
                </li>
              );
            })}
          </ul>
          <div className="-mx-4 hidden overflow-x-auto px-4 sm:block">
            <table className="w-full min-w-[46rem] text-base">
              <thead className="text-left text-sm text-muted">
                <tr>
                  <th className="py-3 pr-4 font-normal">Who</th>
                  <th className="py-3 pr-4 font-normal">Stage</th>
                  <th className="py-3 pr-4 font-normal">Heuristic score</th>
                  <th className="py-3 pr-4 font-normal">Closest report</th>
                  <th className="py-2 font-normal">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((o) => {
                  const ev = (o.explanation as { evidence?: { description: string; distanceMiles: number | null; place: string }[] }).evidence?.[0];
                  return (
                    <tr key={o.id} className="align-top">
                      <td className="py-3 pr-4">
                        <a className="font-medium underline" href={`/orgs/${orgId}/scout/opportunities/${o.id}`}>{o.prospect.name}</a>{" "}
                        {o.demo && <DemoBadge />}
                        <div className="text-sm text-muted">{[o.prospect.city, o.prospect.county && `${o.prospect.county} Co.`, o.prospect.state].filter(Boolean).join(", ")}</div>
                      </td>
                      <td className="py-3 pr-4"><StageBadge stage={o.stage} /></td>
                      <td className="w-36 py-3 pr-4"><ScoreCell score={o.score} breakdown={o.scoreBreakdown} /></td>
                      <td className="py-3 pr-4">
                        {ev ? <>{ev.description}, {ev.distanceMiles === null ? "same county" : `${ev.distanceMiles} mi`}<div className="text-sm text-muted">{ev.place}</div></> : <span className="text-muted">—</span>}
                      </td>
                      <td className="py-2 text-sm text-muted"><When date={o.updatedAt} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>
      {!isManager && <p className="mt-3 text-sm text-muted">Managers change setup and record contact permissions.</p>}
    </div>
  );
}
