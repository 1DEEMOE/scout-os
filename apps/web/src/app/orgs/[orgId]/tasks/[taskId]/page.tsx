import { notFound } from "next/navigation";
import { AppError, finishedWithoutActions, getEngine, getTask, taskLabel, TERMINAL, verifyJobPhotoChain, type Plan } from "@wos/core";
import { ActionButton } from "../../../../actions";
import { orgContext } from "@/server/org-context";
import { PacketAdd } from "./packet-add";
import { Badge, Card, Empty, MockBadge, PageTitle, StateBadge, TaskStatus, TierBadge, When } from "../../../../ui";

export const dynamic = "force-dynamic";

export default async function TaskPage({ params }: { params: Promise<{ orgId: string; taskId: string }> }) {
  const { orgId, taskId } = await params;
  const { userId, isManager, org } = await orgContext(orgId);
  const staff = org.role !== "viewer";
  let data;
  try {
    data = await getTask({ actorUserId: userId, orgId, taskId });
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const { task, steps, approvals } = data;
  const plan = task.plan as (Plan & { direct?: unknown }) | null;
  const tools = getEngine().tools;
  const err = task.error as { message: string; code?: string } | null;
  const photoVerify = await verifyJobPhotoChain({ actorUserId: userId, orgId, jobId: taskId });

  return (
    <div className="flex flex-col gap-6">
      <a href={`/orgs/${orgId}/tasks`} className="text-sm text-muted underline">All tasks</a>
      <PageTitle
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <TaskStatus state={task.state} noActions={finishedWithoutActions(task)} /> created <When date={task.createdAt} />
            {task.attempts > 1 && <> · {task.attempts} attempts</>}
          </span>
        }
      >
        {taskLabel(task)}
      </PageTitle>
      {task.title && (
        <details className="-mt-3 text-sm">
          <summary className="cursor-pointer text-muted">Instruction given to the agent</summary>
          <p className="mt-2 rounded bg-line/30 p-3 whitespace-pre-wrap">{task.intent}</p>
        </details>
      )}
      {err && task.state !== "COMPLETED" && (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-danger/50 bg-danger/5 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span>
            <strong>{task.state === "RETRY_SCHEDULED" ? "Retrying: " : "Stopped: "}</strong>
            {err.message} {err.code && <span className="font-mono text-xs text-muted">({err.code})</span>}
          </span>
          {task.state === "ESCALATED" && isManager && (plan?.steps?.length ?? 0) > 0 && (
            <ActionButton path="task.retry" input={{ orgId, taskId: task.id }} label="Retry" />
          )}
          {!(TERMINAL as readonly string[]).includes(task.state) && (isManager || task.requestedBy === userId) && (
            <ActionButton path="task.cancel" input={{ orgId, taskId: task.id }} label="Cancel task" variant="danger" confirm="Cancel this task? Its pending approvals expire and it will not run." />
          )}
        </div>
      )}
      {finishedWithoutActions(task) && (
        <p role="status" className="rounded-md border border-line px-3 py-2 text-sm">
          This task finished without the agent proposing any action, so nothing was sent or changed.
          {plan?.model?.mock && " In MOCK mode the agents don't plan real actions."}
        </p>
      )}
      <Card title={<span className="flex items-center gap-2">Plan {plan?.model?.mock && <MockBadge />}</span>}>
        {!plan?.steps?.length ? (
          <Empty>{plan?.note || (task.state === "COMPLETED" ? "The agent decided no action was needed." : "Not planned yet.")}</Empty>
        ) : (
          <ol className="flex flex-col gap-3">
            {plan.note && <p className="text-sm text-muted">{plan.note}</p>}
            {plan.steps.map((s) => {
              const ran = steps.filter((e) => e.step === `${s.index}:${s.tool}`);
              const last = ran.at(-1);
              return (
                <li key={s.index} className="rounded border border-line p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.index + 1}. {s.summary}</span>
                    <TierBadge tier={s.tier} />
                    {tools.get(s.tool)?.mock && <MockBadge />}
                    {s.decision === "needs_approval" && <Badge tone="warn">needs approval</Badge>}
                    {last && <Badge tone={last.status === "succeeded" ? "accent" : last.status === "failed" ? "danger" : "muted"}>{last.status}{ran.length > 1 ? ` (attempt ${last.attempt})` : ""}</Badge>}
                  </div>
                  <pre className="mt-2 max-h-48 overflow-auto rounded bg-line/30 p-2 text-xs whitespace-pre-wrap">{JSON.stringify(s.args, null, 2)}</pre>
                  {last?.error && <p className="mt-1 text-xs text-danger">{last.error}</p>}
                </li>
              );
            })}
          </ol>
        )}
      </Card>
      {approvals.length > 0 && (
        <Card title="Approvals" actions={<a className="text-sm underline" href={`/orgs/${orgId}/approvals`}>Approval center</a>}>
          <ul className="divide-y divide-line text-sm">
            {approvals.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{a.summary}</span>
                <StateBadge state={a.status.toUpperCase()} />
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card
        title="Claim packet"
        actions={
          <span className="flex flex-wrap items-center gap-3">
            <a className="inline-flex min-h-11 items-center rounded-full bg-accent px-5 font-medium text-on-accent" href={`/api/orgs/${orgId}/jobs/${taskId}/claim-packet?format=pdf`}>Download PDF</a>
            <a className="inline-flex min-h-11 items-center text-small text-muted underline underline-offset-4" href={`/api/orgs/${orgId}/jobs/${taskId}/claim-packet`}>Web version</a>
          </span>
        }
      >
        <p className="mb-5 text-muted">
          For insurance jobs: every photo and note is hashed, time-stamped and linked to the one before it, so any change, removal or reordering shows up. The PDF lists every hash and a fingerprint of the whole packet.
        </p>
        <p role="status" className={`mb-5 font-medium ${photoVerify.chainIntact ? "" : "text-danger"}`}>
          {photoVerify.photos.length === 0
            ? "Nothing added yet."
            : photoVerify.chainIntact
              ? `Chain intact · ${photoVerify.photos.filter((p) => p.kind === "photo").length} photos, ${photoVerify.photos.filter((p) => p.kind === "note").length} notes`
              : "Integrity problem: the chain or a stored file doesn't verify"}
        </p>
        {photoVerify.flagged.length > 0 && (
          <p className="mb-5 text-danger">Flagged: {photoVerify.flagged.map((f) => `${f.status}${f.note ? ` (${f.note})` : ""}`).join("; ")}</p>
        )}
        {photoVerify.photos.length > 0 && (
          <ol aria-label="Packet items" className="mb-6 flex flex-col gap-3">
            {photoVerify.photos.map((ph) => (
              <li key={ph.id} className="flex flex-col gap-1 rounded-2xl border border-line px-4 py-3">
                <span className="font-medium">#{ph.chainIndex} · {ph.kind === "note" ? "Note" : "Photo"} · {ph.integrityStatus}</span>
                <code className="text-xs break-all text-muted">{ph.sha256}</code>
              </li>
            ))}
          </ol>
        )}
        {staff && <PacketAdd orgId={orgId} jobId={taskId} />}
      </Card>
    </div>
  );
}
