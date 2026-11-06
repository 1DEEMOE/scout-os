import { notFound } from "next/navigation";
import { AppError, finishedWithoutActions, getPauseState, getThread, taskLabel } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { ActionForm } from "../../../../actions";
import { AutoRefresh } from "../../../../auto-refresh";
import { Badge, Card, inputCls, MockBadge, PageTitle, TaskStatus, When } from "../../../../ui";

export const dynamic = "force-dynamic";

/** Hand-offs that may still change without anyone acting. Waiting on a person isn't "running". */
const RUNNING = ["REQUESTED", "CLASSIFIED", "PLANNED", "POLICY_CHECKED", "ASSIGNED", "EXECUTING", "VERIFYING", "RETRY_SCHEDULED"];

export default async function ThreadPage({ params }: { params: Promise<{ orgId: string; threadId: string }> }) {
  const { orgId, threadId } = await params;
  const { userId, org } = await orgContext(orgId);
  let data;
  try {
    data = await getThread({ actorUserId: userId, orgId, threadId });
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const { thread, messages, delegations } = data;
  const pause = await getPauseState({ actorUserId: userId, orgId });
  const running = !pause.paused && delegations.some((d) => RUNNING.includes(d.state));
  const waiting = delegations.filter((d) => d.state === "WAITING_FOR_APPROVAL").length;

  return (
    <div className="flex flex-col gap-6">
      <a href={`/orgs/${orgId}/chat`} className="text-sm text-muted underline">All conversations</a>
      <PageTitle sub="The lead bot hands work to your AI employees as tasks. Anything external still waits in Approvals.">{thread.title}</PageTitle>
      {waiting > 0 && (
        <p role="status" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          {waiting} hand-off{waiting === 1 ? " is" : "s are"} waiting for approval. <a className="underline" href={`/orgs/${orgId}/approvals`}>Open Approvals</a>
        </p>
      )}
      <ol className="flex flex-col gap-3">
        {messages.map((m) => {
          const mine = m.authorType === "user" && m.authorUserId === userId;
          return (
            <li
              key={m.id}
              className={m.authorType === "user" ? "max-w-[90%] self-end rounded-md bg-line/50 px-3 py-2 sm:max-w-[80%]" : "max-w-[90%] rounded-md border border-line px-3 py-2 sm:max-w-[80%]"}
            >
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="font-medium text-ink">{mine ? "You" : m.authorName}</span> {m.mock && <MockBadge />} <When date={m.createdAt} />
              </div>
              <p className="break-words whitespace-pre-wrap">{m.content}</p>
              {delegations
                .filter((d) => d.messageId === m.id)
                .map((d) => (
                  <a key={d.taskId} href={`/orgs/${orgId}/tasks/${d.taskId}`} className="mt-2 flex flex-wrap items-center gap-2 rounded border border-line px-2 py-1.5 text-sm hover:bg-line/30">
                    <Badge>{d.agentKind}</Badge>
                    <span className="min-w-0 flex-1 truncate">{taskLabel({ title: d.title, intent: d.intent })}</span>
                    <TaskStatus state={d.state} noActions={finishedWithoutActions({ state: d.state, plan: d.plan })} />
                  </a>
                ))}
            </li>
          );
        })}
      </ol>
      <AutoRefresh active={running} />
      {org.role !== "viewer" && (
        <Card title="Message">
          {pause.paused && <p className="mb-3 text-sm text-muted">Agents are paused, so the lead bot won&apos;t hand anything off until an owner resumes them.</p>}
          <ActionForm path="chat.send" fixed={{ orgId, threadId }} submitLabel="Send" clientRef resetOnSuccess>
            <textarea name="content" required maxLength={4000} rows={3} placeholder="e.g. Chase overdue invoices and follow up with new leads" className={inputCls} />
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
