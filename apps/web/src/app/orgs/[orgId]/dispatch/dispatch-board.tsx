"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { ErrorText, money, quietButtonCls } from "../../../ui";

type BoardJob = {
  id: string;
  customerName: string;
  status: string;
  crew: string[];
  scheduledFor: string | null;
  totalCents: number;
};
type Member = { id: string; name: string };

const dayMs = 24 * 60 * 60 * 1000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

const STATUS_LABEL: Record<string, string> = {
  booked: "Booked",
  dispatched: "Dispatched",
  in_progress: "In progress",
  done: "Done",
};

/**
 * Day board: crew lanes for the chosen date plus unassigned scheduled work.
 * Tap-first for phones — a dispatcher on a driveway gets big targets and one
 * action per card. Lanes stack vertically on small screens, sit side by side
 * on wide ones.
 */
export function DispatchBoard({ orgId, role, members, jobs }: { orgId: string; role: string; members: Member[]; jobs: BoardJob[] }) {
  const router = useRouter();
  const [day, setDay] = useState(() => dayKey(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isManager = role === "owner" || role === "admin";
  const isStaff = isManager || role === "member";

  const shift = (days: number) => setDay((d) => dayKey(new Date(new Date(`${d}T12:00:00`).getTime() + days * dayMs)));

  const todays = useMemo(() => jobs.filter((j) => j.scheduledFor && j.scheduledFor.slice(0, 10) === day), [jobs, day]);
  const unassigned = todays.filter((j) => j.crew.length === 0);
  const lanes = members
    .map((m) => ({ member: m, jobs: todays.filter((j) => j.crew.includes(m.id)) }))
    .filter((l) => l.jobs.length > 0 || members.length <= 8); // empty lanes only when the team is small enough to plan on

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

  function JobCard({ job }: { job: BoardJob }) {
    return (
      <li className="flex flex-col gap-2 rounded-2xl border border-line bg-canvas px-4 py-3">
        <a href={`/orgs/${orgId}/jobs/${job.id}`} className="flex items-center justify-between gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{job.customerName}</span>
          <span className="shrink-0 text-base">{money(job.totalCents)}</span>
        </a>
        <span className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted">{STATUS_LABEL[job.status] ?? job.status}</span>
          {isStaff && job.status === "dispatched" && (
            <button type="button" disabled={busy} className="min-h-10 rounded-full border border-line px-4 text-sm font-medium" onClick={() => run(() => trpc.jobs.advance.mutate({ orgId, jobId: job.id, to: "in_progress" }))}>
              Start
            </button>
          )}
          {isStaff && job.status === "in_progress" && (
            <button type="button" disabled={busy} className="min-h-10 rounded-full border border-line px-4 text-sm font-medium" onClick={() => run(() => trpc.jobs.advance.mutate({ orgId, jobId: job.id, to: "done" }))}>
              Done
            </button>
          )}
          {isManager && job.status === "booked" && job.crew.length > 0 && (
            <button type="button" disabled={busy} className="min-h-10 rounded-full bg-accent px-4 text-sm font-semibold text-on-accent" onClick={() => run(() => trpc.jobs.dispatch.mutate({ orgId, jobId: job.id }))}>
              Dispatch
            </button>
          )}
        </span>
      </li>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-2">
        <button type="button" className={quietButtonCls} onClick={() => shift(-1)} aria-label="Previous day">←</button>
        <div className="flex items-center gap-3">
          <strong className="text-lg">{new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</strong>
          {day !== dayKey(new Date()) && (
            <button type="button" className="text-base underline" onClick={() => setDay(dayKey(new Date()))}>Today</button>
          )}
        </div>
        <button type="button" className={quietButtonCls} onClick={() => shift(1)} aria-label="Next day">→</button>
      </div>

      {todays.length === 0 ? (
        <p className="rounded-[var(--radius-card)] border border-line bg-canvas px-5 py-6 text-center text-base text-muted">
          Nothing scheduled. Booked jobs appear here once they have a date.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 2xl:grid-cols-3">
          {unassigned.length > 0 && (
            <section aria-label="Unassigned" className="flex flex-col gap-3">
              <h2 className="text-base font-semibold text-muted">Unassigned ({unassigned.length})</h2>
              <ul className="flex flex-col gap-3">{unassigned.map((j) => <JobCard key={j.id} job={j} />)}</ul>
            </section>
          )}
          {lanes.map((l) => (
            <section key={l.member.id} aria-label={l.member.name} className="flex flex-col gap-3">
              <h2 className="text-base font-semibold">{l.member.name} <span className="text-muted">({l.jobs.length})</span></h2>
              {l.jobs.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-line px-4 py-3 text-sm text-muted">Open today</p>
              ) : (
                <ul className="flex flex-col gap-3">{l.jobs.map((j) => <JobCard key={j.id} job={j} />)}</ul>
              )}
            </section>
          ))}
        </div>
      )}
      <ErrorText message={error} />
    </div>
  );
}
