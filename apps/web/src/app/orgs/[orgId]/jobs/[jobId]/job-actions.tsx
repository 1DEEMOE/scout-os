"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, dangerButtonCls, ErrorText, inputCls, quietButtonCls } from "../../../../ui";
import type { JobStatus } from "@wos/core";

type Member = { id: string; name: string };

/**
 * Every action the pipeline allows, rendered only where the status machine
 * allows it. The server re-checks both the role and the transition — these
 * buttons are convenience, not the boundary. "Send estimate" never sends: it
 * files an approval, and the Approvals page is where a person releases it.
 */
export function JobActions(props: {
  orgId: string;
  jobId: string;
  status: JobStatus;
  role: string;
  blocked: boolean;
  hasEmail: boolean;
  crew: string[];
  scheduledFor: string | null;
  members: Member[];
}) {
  const { orgId, jobId, status, role, blocked, hasEmail, crew, scheduledFor, members } = props;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(scheduledFor ? scheduledFor.slice(0, 10) : "");
  const [picked, setPicked] = useState<string[]>(crew);

  const isManager = role === "owner" || role === "admin";
  const isStaff = isManager || role === "member";

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (status === "done" || status === "cancelled" || status === "lost") return null;

  return (
    <section aria-label="Actions" className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-canvas px-5 py-5">
      <h2 className="text-lg font-semibold">Next step</h2>

      <div className="flex flex-wrap gap-3">
        {status === "inquiry" && isStaff && (
          <button type="button" disabled={busy} className={buttonCls} onClick={() => run(() => trpc.jobs.prepareEstimate.mutate({ orgId, jobId }))}>
            Prepare estimate
          </button>
        )}
        {status === "estimate_ready" && isManager && (
          <button
            type="button"
            disabled={busy || blocked || !hasEmail}
            className={buttonCls}
            title={blocked ? "Resolve the blockers on the estimate first" : !hasEmail ? "Add the customer's email first" : undefined}
            onClick={() => run(() => trpc.jobs.sendEstimate.mutate({ orgId, jobId }))}
          >
            Send estimate for approval
          </button>
        )}
        {status === "approval_pending" && isManager && (
          <button type="button" disabled={busy} className={quietButtonCls} onClick={() => run(() => trpc.jobs.returnToDraft.mutate({ orgId, jobId }))}>
            Back to draft
          </button>
        )}
        {status === "estimate_sent" && isManager && (
          <>
            <button type="button" disabled={busy} className={buttonCls} onClick={() => run(() => trpc.jobs.outcome.mutate({ orgId, jobId, result: "booked" }))}>
              Customer booked
            </button>
            <button type="button" disabled={busy} className={quietButtonCls} onClick={() => run(() => trpc.jobs.outcome.mutate({ orgId, jobId, result: "lost" }))}>
              Mark lost
            </button>
          </>
        )}
        {status === "dispatched" && isStaff && (
          <button type="button" disabled={busy} className={buttonCls} onClick={() => run(() => trpc.jobs.advance.mutate({ orgId, jobId, to: "in_progress" }))}>
            Start work
          </button>
        )}
        {status === "in_progress" && isStaff && (
          <button type="button" disabled={busy} className={buttonCls} onClick={() => run(() => trpc.jobs.advance.mutate({ orgId, jobId, to: "done" }))}>
            Mark done
          </button>
        )}
        {isManager && (
          <button
            type="button"
            disabled={busy}
            className={dangerButtonCls}
            onClick={() => {
              if (window.confirm("Cancel this job? This can't be undone.")) void run(() => trpc.jobs.cancel.mutate({ orgId, jobId }));
            }}
          >
            Cancel job
          </button>
        )}
      </div>

      {(status === "booked" || status === "dispatched") && isManager && (
        <div className="flex flex-col gap-4 border-t border-line pt-4">
          <label className="flex max-w-xs flex-col gap-1 text-base">
            Job date
            <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <div className="flex flex-col gap-2">
            <span className="text-base font-medium">Crew</span>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {members.map((m) => (
                <label key={m.id} className="flex min-h-12 items-center gap-3 rounded-xl border border-line px-4">
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-[var(--accent)]"
                    checked={picked.includes(m.id)}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, m.id] : p.filter((x) => x !== m.id)))}
                  />
                  <span className="text-base">{m.name}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy}
              className={quietButtonCls}
              onClick={() =>
                run(async () => {
                  await trpc.jobs.schedule.mutate({ orgId, jobId, scheduledFor: date ? new Date(`${date}T09:00:00`).toISOString() : null });
                  await trpc.jobs.assignCrew.mutate({ orgId, jobId, memberIds: picked });
                })
              }
            >
              Save schedule & crew
            </button>
            {status === "booked" && (
              <button
                type="button"
                disabled={busy || !date || picked.length === 0}
                title={!date ? "Set a date first" : picked.length === 0 ? "Assign at least one crew member" : undefined}
                className={buttonCls}
                onClick={() =>
                  run(async () => {
                    await trpc.jobs.schedule.mutate({ orgId, jobId, scheduledFor: date ? new Date(`${date}T09:00:00`).toISOString() : null });
                    await trpc.jobs.assignCrew.mutate({ orgId, jobId, memberIds: picked });
                    await trpc.jobs.dispatch.mutate({ orgId, jobId });
                  })
                }
              >
                Dispatch crew
              </button>
            )}
          </div>
        </div>
      )}

      <ErrorText message={error} />
    </section>
  );
}
