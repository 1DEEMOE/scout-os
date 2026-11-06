import { listSignals, planSummary } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { Card, Empty, inputCls, PageTitle } from "../../../../ui";
import { DemoBadge, ScoutTabs, UpgradeNotice, Utc } from "../parts";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = { hail: "Hail", wind: "Wind", tornado: "Tornado" };

function magnitude(s: { kind: string; magnitude: number | null; magnitudeUnit: string | null }) {
  if (s.kind === "tornado") return "—";
  if (s.magnitude === null) return s.kind === "wind" ? "not measured" : "not given";
  return s.magnitudeUnit === "in" ? `${Number(s.magnitude).toFixed(2)} in.` : `${s.magnitude} mph`;
}

export default async function SignalsPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ kind?: string; state?: string }> }) {
  const { orgId } = await params;
  const q = await searchParams;
  const { userId, org } = await orgContext(orgId);
  const plan = await planSummary({ actorUserId: userId, orgId });
  if (!plan.plan.features.includes("scout")) return <UpgradeNotice orgId={orgId} planLabel={plan.plan.label} />;
  const kind = ["hail", "wind", "tornado"].includes(q.kind ?? "") ? q.kind : undefined;
  const state = /^[A-Za-z]{2}$/.test(q.state ?? "") ? q.state!.toUpperCase() : undefined;
  const rows = await listSignals({ actorUserId: userId, orgId, kind, state, limit: 500 });
  return (
    <div>
      <PageTitle sub="NOAA Storm Prediction Center local storm reports you uploaded. Preliminary, not quality-controlled, and never evidence that a specific property was damaged.">Storm reports</PageTitle>
      <ScoutTabs orgId={orgId} active="signals" role={org.role} />
      <Card
        title={`${rows.length}${rows.length === 500 ? "+" : ""} reports`}
        actions={
          <form className="flex flex-wrap items-end gap-2 text-sm">
            <label className="flex flex-col gap-1">Type
              <select name="kind" defaultValue={kind ?? ""} className={`${inputCls} w-32`}>
                <option value="">All</option><option value="hail">Hail</option><option value="wind">Wind</option><option value="tornado">Tornado</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">State
              <input name="state" defaultValue={state ?? ""} maxLength={2} placeholder="TX" className={`${inputCls} w-20 uppercase`} />
            </label>
            <button className="rounded-md border border-line px-3 py-2">Filter</button>
          </form>
        }
      >
        {rows.length === 0 ? (
          <Empty>No storm reports{kind || state ? " match these filters" : " yet. Upload one in Setup"}.</Empty>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[48rem] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-2 pr-3 font-normal">When (UTC, as reported)</th>
                  <th className="py-2 pr-3 font-normal">Type</th>
                  <th className="py-2 pr-3 font-normal">Size / speed</th>
                  <th className="py-2 pr-3 font-normal">Place</th>
                  <th className="py-2 font-normal">Reporter&apos;s comments</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((s) => (
                  <tr key={s.id} className="align-top">
                    <td className="py-2 pr-3 whitespace-nowrap"><Utc date={s.eventAt} /></td>
                    <td className="py-2 pr-3">{KIND_LABEL[s.kind]} {s.demo && <DemoBadge />}</td>
                    <td className="py-2 pr-3 tabular-nums">{magnitude(s)}</td>
                    <td className="py-2 pr-3">{s.location}<div className="text-xs text-muted">{s.county} County, {s.state}{s.lat !== null ? ` · ${s.lat.toFixed(2)}, ${s.lon!.toFixed(2)}` : ""}</div></td>
                    <td className="py-2 text-xs text-muted">{s.comments || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">Source: NOAA Storm Prediction Center (US government work, public domain). No map is shown: these are point reports, and a map would suggest coverage that doesn&apos;t exist.</p>
      </Card>
    </div>
  );
}
