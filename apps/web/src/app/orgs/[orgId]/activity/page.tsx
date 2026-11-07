import { activityFeed, laneOf } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { notFound } from "next/navigation";
import { Badge, Card, Empty, PageTitle } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function ActivityPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, isManager } = await orgContext(orgId);
  if (!isManager) notFound();
  const groups = await activityFeed({ actorUserId: userId, orgId });
  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="What Scout did, step by step. Customer text and secrets are left out.">Activity</PageTitle>
      {groups.length === 0 ? <Empty>Nothing has happened in this workspace yet.</Empty> : (
        <ul className="flex flex-col gap-6">
          {groups.slice(0, 30).map((group) => (
            <li key={group.job}>
              <Card>
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{laneOf(group.steps.map((s) => s.action).join(" "))}</Badge>
                    <h2 className="text-lg font-semibold">{group.job}</h2>
                  </div>
                  <ol className="flex flex-col gap-2">
                    {group.steps.map((step, i) => (
                      <li key={`${step.at}-${i}`} className="text-base"><span className="text-muted">{step.stage} · </span>{step.action}</li>
                    ))}
                  </ol>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
