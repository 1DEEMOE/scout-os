import { notFound } from "next/navigation";
import { AppError, finishedWithoutActions, getEngine, getTask, nextActionChips, taskLabel, TERMINAL, verifyJobPhotoChain, watchTask, type Plan } from "@wos/core";
import { ActionButton, ActionForm } from "../../../../actions";
import { orgContext } from "@/server/org-context";
import { Badge, Card, Empty, inputCls, MockBadge, PageTitle, StateBadge, TaskStatus, TierBadge, When } from "../../../../ui";

export const dynamic = "force-dynamic";

export default async function TaskPage({ params }: { params: Promise<{ orgId: string; taskId: string }> }) {
  const { orgId, taskId } = await params;
  const { userId, isManager } = await orgContext(orgId);
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
  const watch = await watchTask({ actorUserId: userId, orgId, taskId }).catch(() => null);

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
      {watch && (
        <Card>
          <div className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Watch this job</h2>
            <p className="text-base text-muted">{watch.paused ? "Paused. Scout will not take the next step until you hand it back." : "Scout stops at an approval card. Taking over the draft does not send it."}</p>
            {watch.draft && <p className="rounded-2xl border border-line px-4 py-3 text-base">{watch.draft}</p>}
            {isManager && (
              <ActionForm path="kimi.takeOver" fixed={{ orgId, taskId }} submitLabel={watch.paused ? "Update the draft" : "Take over this draft"} quiet>
                <label htmlFor={`takeover-${taskId}`} className="text-base">Your draft</label>
                <textarea id={`takeover-${taskId}`} name="text" required rows={4} defaultValue={watch.draft} placeholder="Write the reply. Taking over does not send it." className={inputCls} />
              </ActionForm>
            )}
            <div className="flex flex-wrap gap-2">
              {isManager && !watch.paused && <ActionButton path="kimi.pause" input={{ orgId, taskId }} label="Pause" />}
              {isManager && watch.paused && <ActionButton path="kimi.handBack" input={{ orgId, taskId }} label="Hand back" />}
            </div>
            <ul aria-label="Suggested next steps" className="flex flex-col gap-2">
              {nextActionChips(taskLabel(task)).map((chip) => (
                <li key={chip.kind}>
                  <ActionButton path="kimi.chip" input={{ orgId, taskId, kind: chip.kind, label: chip.label }} label={chip.label} variant="quiet" redirectToTask={{ orgId }} />
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}
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
        title="Job photos"
        actions={
          <a className="text-sm underline" href={`/api/orgs/${orgId}/jobs/${taskId}/claim-packet`}>
            Download claim packet
          </a>
        }
      >
        <p className="mb-3 text-base text-muted">
          {photoVerify.photos.length === 0
            ? "No photos yet. Uploads are hashed and chained for this job."
            : photoVerify.chainIntact
              ? `Chain intact · ${photoVerify.photos.length} photo${photoVerify.photos.length === 1 ? "" : "s"}`
              : "Integrity problem — chain or bytes do not verify"}
        </p>
        {photoVerify.flagged.length > 0 && (
          <p className="mb-3 text-base text-danger">
            Flagged: {photoVerify.flagged.map((f) => `${f.status}${f.note ? ` (${f.note})` : ""}`).join("; ")}
          </p>
        )}
        {photoVerify.photos.length > 0 && (
          <ul className="divide-y divide-line text-sm">
            {photoVerify.photos.map((ph) => (
              <li key={ph.id} className="flex flex-col gap-1 py-3">
                <span className="font-medium">#{ph.chainIndex} · {ph.integrityStatus}</span>
                <code className="break-all text-xs text-muted">{ph.sha256}</code>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4">
          <ActionButton
            path="gaps2.jobPhotoUpload"
            input={{
              orgId,
              jobId: taskId,
              filename: "field.jpg",
              contentType: "image/jpeg",
              bytesBase64: Buffer.from("scout-os-demo-photo").toString("base64"),
              captureAt: new Date().toISOString(),
            }}
            label="Add demo photo"
            variant="quiet"
          />
        </div>
      </Card>
    </div>
  );
}
