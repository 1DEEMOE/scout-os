import { notFound } from "next/navigation";
import { AppError, getRoutine, type Briefing } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { Card, Empty, PageTitle } from "../../../../ui";
import { BriefingView, fmtIn, RunStatus } from "../parts";

export const dynamic = "force-dynamic";

export default async function RoutinePage({ params, searchParams }: { params: Promise<{ orgId: string; routineId: string }>; searchParams: Promise<{ run?: string }> }) {
  const { orgId, routineId } = await params;
  const { run: runParam } = await searchParams;
  const { userId } = await orgContext(orgId);
  const data = await getRoutine({ actorUserId: userId, orgId, routineId }).catch((err) => {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  });
  const { routine: r, runs } = data;
  const shown = runs.find((x) => x.id === runParam) ?? runs.find((x) => x.status !== "running");
  return (
    <div className="flex flex-col gap-6">
      <PageTitle sub={`Coordinator · ${r.scheduleText} · ${r.status}${r.status === "active" ? ` · next ${fmtIn(r.nextRunAt, r.timezone)}` : ""}`}>{r.name}</PageTitle>
      <Card title="Runs">
        {runs.length === 0 ? (
          <Empty>No runs yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {runs.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-2">
                <a className="underline" href={`?run=${x.id}`}>{fmtIn(x.startedAt, r.timezone)}</a>
                <span className="text-muted">{x.trigger}</span>
                <RunStatus run={x} />
                {x.error && <span className="text-danger">{x.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {shown && (
        <Card title={`Sources read · run of ${fmtIn(shown.startedAt, r.timezone)}`}>
          {shown.sources.length === 0 ? (
            <Empty>No sources read (run was skipped before reading).</Empty>
          ) : (
            <ul className="text-sm">
              {shown.sources.map((s) => (
                <li key={s.source}>
                  <code>{s.source}</code> · {s.rows < 0 ? <span className="text-danger">could not be read</span> : `${s.rows} row${s.rows === 1 ? "" : "s"}`}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {shown?.status === "succeeded" && shown.output ? <BriefingView briefing={shown.output as Briefing} /> : null}
    </div>
  );
}
