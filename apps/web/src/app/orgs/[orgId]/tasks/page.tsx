import { finishedWithoutActions, listTasks, taskLabel } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { ActionForm } from "../../../actions";
import { Card, Empty, inputCls, PageTitle, TaskStatus, When } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function TasksPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, org } = await orgContext(orgId);
  const tasks = await listTasks({ actorUserId: userId, orgId });
  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="Ask your AI employees for something. Anything external waits for approval.">Tasks</PageTitle>
      {org.role !== "viewer" && (
        <Card title="New request">
          <ActionForm path="task.create" fixed={{ orgId }} submitLabel="Send to agents" redirectToTask={{ orgId }}>
            <textarea name="intent" required maxLength={2000} rows={3} placeholder="e.g. Draft replies to this week's billing questions" className={inputCls} />
          </ActionForm>
        </Card>
      )}
      {tasks.length === 0 ? (
        <Empty action={<span className="text-base text-muted">Ask your AI staff for something above.</span>}>No tasks yet.</Empty>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {tasks.map((t) => (
            <li key={t.id}>
              <a href={`/orgs/${orgId}/tasks/${t.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 hover:bg-line/40">
                <span className="min-w-0 flex-1 truncate">{taskLabel(t)}</span>
                <span className="flex items-center gap-3 text-base"><TaskStatus state={t.state} noActions={finishedWithoutActions(t)} /><When date={t.createdAt} /></span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
