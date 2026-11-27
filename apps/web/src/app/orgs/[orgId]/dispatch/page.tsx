import { listJobs, listMembers } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { AppError } from "@wos/core";
import { Empty, PageTitle } from "../../../ui";
import { DispatchBoard } from "./dispatch-board";

export const dynamic = "force-dynamic";

export default async function DispatchPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, org } = await orgContext(orgId);

  try {
    const [jobs, members] = await Promise.all([
      listJobs({ actorUserId: userId, orgId }),
      listMembers({ actorUserId: userId, orgId }),
    ]);
    return (
      <div className="flex flex-col gap-8">
        <PageTitle sub="One day at a time. Who's going where, with which crew. A person dispatches every job — never an agent.">
          Dispatch
        </PageTitle>
        <DispatchBoard
          orgId={orgId}
          role={org.role}
          members={members.filter((m) => m.role !== "viewer").map((m) => ({ id: m.userId, name: m.name }))}
          jobs={jobs
            .filter((j) => ["booked", "dispatched", "in_progress", "done"].includes(j.status))
            .map((j) => ({
              id: j.id,
              customerName: j.customerName,
              status: j.status,
              crew: j.crew,
              scheduledFor: j.scheduledFor,
              totalCents: j.estimate.totalCents,
            }))}
        />
      </div>
    );
  } catch (e) {
    if (e instanceof AppError && e.code === "VALIDATION") {
      return (
        <div className="flex flex-col gap-8">
          <PageTitle>Dispatch</PageTitle>
          <Empty>Dispatch isn&apos;t available for this workspace&apos;s industry yet.</Empty>
        </div>
      );
    }
    throw e;
  }
}
