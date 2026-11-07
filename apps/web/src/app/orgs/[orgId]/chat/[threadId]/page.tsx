import { notFound } from "next/navigation";
import { AppError, approvalsForReview, finishedWithoutActions, getPauseState, getThread, taskLabel } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { AutoRefresh } from "../../../../auto-refresh";
import { Badge, TaskStatus } from "../../../../ui";
import { ApprovalCard, PersonMessage, ScoutMessage, Transcript } from "../../chat-ui";
import { RememberedChip } from "../../remembered-chip";
import { Composer } from "../../composer";

export const dynamic = "force-dynamic";

/** Hand-offs that may still change without anyone acting. Waiting on a person isn't "running". */
const RUNNING = ["REQUESTED", "CLASSIFIED", "PLANNED", "POLICY_CHECKED", "ASSIGNED", "EXECUTING", "VERIFYING", "RETRY_SCHEDULED"];

const TEAMMATE: Record<string, string> = { inbox: "Inbox", sales: "Pipeline", finance: "Billing", scout: "Scout", scheduling: "Scheduling", reporting: "Analyst", orchestrator: "Coordinator" };

function parseRemembered(content: string): { memoryId: string; text: string } | null {
  const match = /^\[\[kimi:remembered:([0-9a-f-]{36})\]\]Remembered: ([\s\S]+)$/.exec(content);
  if (!match) return null;
  return { memoryId: match[1]!, text: match[2]! };
}

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
  const [pause, review] = await Promise.all([getPauseState({ actorUserId: userId, orgId }), approvalsForReview({ actorUserId: userId, orgId })]);
  const running = !pause.paused && delegations.some((d) => RUNNING.includes(d.state));
  const taskIds = new Set(delegations.map((d) => d.taskId));
  const approvals = review.open.filter((a) => taskIds.has(a.taskId));

  return (
    <div className="mx-auto flex max-w-3xl flex-col">
      <header className="mb-10">
        <a href={`/orgs/${orgId}/chat`} className="inline-flex min-h-10 items-center text-muted underline decoration-line underline-offset-4 hover:text-ink">All conversations</a>
        <h1 className="mt-2 text-display font-semibold">{thread.title}</h1>
      </header>

      <Transcript label="Conversation">
        {messages.map((m) => {
          const steps = delegations.filter((d) => d.messageId === m.id);
          const remembered = parseRemembered(m.content);
          const body = remembered ? (
            <RememberedChip orgId={orgId} memoryId={remembered.memoryId} text={remembered.text} />
          ) : (
            <p className="break-words whitespace-pre-wrap">{m.content}</p>
          );
          if (m.authorType === "user") {
            return (
              <PersonMessage key={m.id} name={m.authorUserId === userId ? "You" : m.authorName} at={m.createdAt}>
                {m.content}
              </PersonMessage>
            );
          }
          return (
            <ScoutMessage key={m.id} at={m.createdAt} mock={m.mock}>
              <div className="text-message leading-relaxed">{body}</div>
              {steps.length > 0 && (
                <ul aria-label="Hand-offs" className="mt-4 flex flex-col gap-2">
                  {steps.map((d) => (
                    <li key={d.taskId}>
                      <a href={`/orgs/${orgId}/tasks/${d.taskId}`} className="flex min-h-12 flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-2.5 transition-colors duration-150 hover:bg-soft">
                        <Badge>{TEAMMATE[d.agentKind] ?? d.agentKind}</Badge>
                        <span className="min-w-0 flex-1 truncate">{taskLabel({ title: d.title, intent: d.intent })}</span>
                        <TaskStatus state={d.state} noActions={finishedWithoutActions({ state: d.state, plan: d.plan })} />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </ScoutMessage>
          );
        })}
        {approvals.length > 0 && (
          <ScoutMessage title={`${approvals.length === 1 ? "This needs" : "These need"} your OK before ${approvals.length === 1 ? "it happens" : "they happen"}.`}>
            <div className="flex flex-col gap-4">
              {approvals.map((item) => (
                <ApprovalCard key={item.approval.id} item={item} orgId={orgId} />
              ))}
            </div>
          </ScoutMessage>
        )}
        {running && (
          <li role="status" className="flex items-center gap-3 pl-12 text-muted">
            <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
            Your teammates are working on it…
          </li>
        )}
      </Transcript>
      <AutoRefresh active={running} />

      {org.role !== "viewer" ? (
        <div className="sticky bottom-24 z-10 mt-12 bg-gradient-to-t from-paper from-70% to-transparent pt-6 lg:bottom-6">
          <Composer orgId={orgId} threadId={threadId} disabledReason={pause.paused ? "Agents are paused, so Scout won't hand anything off until an owner resumes them." : undefined} />
        </div>
      ) : (
        <p className="mt-12 text-muted">You have view-only access to this conversation.</p>
      )}
    </div>
  );
}
