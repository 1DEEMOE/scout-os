import { latestBriefing, type Briefing } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { Empty, PageTitle } from "../../../../ui";
import { BriefingView, fmtIn } from "../parts";

export const dynamic = "force-dynamic";

export default async function BriefingPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId } = await orgContext(orgId);
  const latest = await latestBriefing({ actorUserId: userId, orgId });
  const b = latest?.run.output as Briefing | undefined;
  return (
    <div className="flex flex-col gap-6">
      <PageTitle sub={b ? `${latest!.routineName} · generated ${fmtIn(b.generatedAt, b.timezone)} · read-only, in-app only` : undefined}>Morning Briefing</PageTitle>
      {b ? <BriefingView briefing={b} /> : <Empty>No briefing yet. Create a Morning Briefing routine on the <a className="underline" href={`/orgs/${orgId}/routines`}>Routines</a> page, or run one now.</Empty>}
    </div>
  );
}
