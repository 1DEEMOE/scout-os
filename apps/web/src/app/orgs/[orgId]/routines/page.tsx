import { getPauseState, listRoutines } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { ActionButton } from "../../../actions";
import { Badge, Card, Empty, PageTitle } from "../../../ui";
import { NewRoutineForm, RunNowButton } from "./forms";
import { fmtIn, RunStatus } from "./parts";

export const dynamic = "force-dynamic";

export default async function RoutinesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, isManager } = await orgContext(orgId);
  const [list, pause] = await Promise.all([listRoutines({ actorUserId: userId, orgId }), getPauseState({ actorUserId: userId, orgId })]);
  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="Scheduled work your Coordinator does on its own. Routines only read and summarize. Anything that sends, pays, or changes records still waits for your OK.">Routines</PageTitle>
      {pause.paused && (
        <Card>
          <p className="text-base text-danger">Agents are paused for this organization. Scheduled runs are recorded as skipped until an owner resumes them in Settings.</p>
        </Card>
      )}
      <p className="text-base"><a className="underline" href={`/orgs/${orgId}/routines/briefing`}>Open the latest Morning Briefing →</a></p>
      <Card title="Your routines">
        {list.length === 0 ? (
          <Empty>No routines yet.{isManager ? " Create a Morning Briefing below." : " An owner or admin can create one."}</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {list.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col gap-1">
                  <a className="font-medium underline" href={`/orgs/${orgId}/routines/${r.id}`}>{r.name}</a>
                  <span className="text-base text-muted">Coordinator · {r.scheduleText}</span>
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone={r.status === "active" ? "accent" : "muted"}>{r.status}</Badge>
                    {r.status === "active" && <span className="text-muted">next {fmtIn(r.nextRunAt, r.timezone)}</span>}
                    {r.lastRun && <>last run <RunStatus run={r.lastRun} /></>}
                  </span>
                </div>
                {isManager && (
                  <div className="flex gap-2">
                    <RunNowButton orgId={orgId} routineId={r.id} disabled={pause.paused} />
                    {r.status === "active" ? (
                      <ActionButton path="routines.pause" input={{ orgId, routineId: r.id }} label="Pause" />
                    ) : (
                      <ActionButton path="routines.resume" input={{ orgId, routineId: r.id }} label="Resume" />
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {isManager && (
        <Card title="New Morning Briefing">
          <p className="mb-3 text-base text-muted">Each morning the Coordinator reads storm signals and top prospects, unanswered leads, stalled deals, follow-ups due, overdue invoices and pending approvals, and leaves a briefing here. It's in-app only: nothing is emailed or texted. Set-up is here in the app; chat can't create routines yet.</p>
          <NewRoutineForm orgId={orgId} defaultTz="America/New_York" />
        </Card>
      )}
    </div>
  );
}
