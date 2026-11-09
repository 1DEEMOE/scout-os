import { latestAiAnswersCheck, listAiAnswersTrend } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { Badge, Card, Empty, MockBadge, PageTitle, TierBadge } from "../../../ui";
import { VisibilityCheck } from "./check-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI visibility" };

/** Do AI assistants recommend this shop when someone asks for its trade nearby? */
export default async function AiVisibilityPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, org } = await orgContext(orgId);
  const who = { actorUserId: userId, orgId };
  const [latest, trend] = await Promise.all([latestAiAnswersCheck(who), listAiAnswersTrend(who)]);
  const mock = !latest || latest.provider === "mock";
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <PageTitle sub="When someone asks an AI assistant for your trade near them, do you come up? Scout checks once a month and tells you what to fix.">AI visibility</PageTitle>
      {mock && (
        <p role="note" className="flex flex-wrap items-center gap-2 rounded-2xl border border-warn/40 bg-warn/5 px-5 py-4">
          <MockBadge /> No live assistant is asked yet. Scores come from a simulated check so you can see how this works; the advice is general good practice. <TierBadge tier={0} />
        </p>
      )}
      {latest ? (
        <Card title={<span className="flex flex-wrap items-center gap-2">Latest check · {latest.period} {latest.provider === "mock" && <MockBadge />}</span>}>
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-end gap-6">
              <p><span className="text-display font-semibold tabular-nums">{latest.score}</span><span className="text-muted"> / 100</span></p>
              <Badge tone={latest.recommended ? "accent" : "warn"}>{latest.recommended ? "Recommended" : "Not clearly recommended yet"}</Badge>
              {latest.trendDelta !== null && <span className="text-muted">{latest.trendDelta >= 0 ? "▲" : "▼"} {Math.abs(latest.trendDelta)} since last check</span>}
            </div>
            <p className="text-muted">{latest.trade} in {latest.zip}</p>
            <div>
              <h2 className="mb-3 font-semibold">What to do next</h2>
              <ol className="list-decimal space-y-2 pl-5">
                {(latest.suggestions as string[]).slice(0, 3).map((s) => <li key={s}>{s}</li>)}
              </ol>
            </div>
          </div>
        </Card>
      ) : (
        <Empty>No checks yet. Run the first one below.</Empty>
      )}
      {org.role !== "viewer" && (
        <Card title="Run a check">
          <VisibilityCheck orgId={orgId} defaultTrade={latest?.trade ?? "roofing"} defaultZip={latest?.zip ?? ""} />
        </Card>
      )}
      {trend.length > 1 && (
        <Card title="Over time">
          <ul aria-label="Past checks" className="flex flex-col gap-3">
            {trend.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-4">
                <span>{t.period} · {t.trade} in {t.zip}</span>
                <span className="tabular-nums">{t.score}/100</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
